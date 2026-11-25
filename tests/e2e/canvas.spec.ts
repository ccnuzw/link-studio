import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32 } from "node:zlib";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import { defaultDirectorScene } from "../../packages/link-studio-core/src/director";
import type { ProjectState } from "../../packages/link-studio-core/src/project";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { projectCanvas } from "../../src/main/project/canvas";
import { contentHash } from "../../src/main/project/encoding";
import { orientedJpeg } from "../fixtures/jpeg-orientation";
import { chooseAssistantModel, expectDraft } from "./assistant-theme";
import { compactViewport, desktopElectron as electron } from "./desktop-window";
import { annotateWithComposition } from "./doodle-composition";
import {
  addCanvasNode,
  blankCanvasPosition,
  chooseCanvasZoom,
  clickBlankCanvas,
  createCanvasProject,
  editTextNode,
  projectAction,
} from "./workspace-actions";

async function projectDirectory(root: string) {
  const project = (await readdir(root)).find((name) => name.endsWith(".linkstudio"));
  if (!project) throw new Error("画布项目不存在");
  return join(root, project);
}

async function latestSnapshot(root: string): Promise<ProjectState> {
  const state = join(await projectDirectory(root), "state");
  const filename = (await readdir(state)).sort().at(-1);
  if (!filename) throw new Error("画布快照不存在");
  return JSON.parse(await readFile(join(state, filename), "utf8"));
}

function launchCanvas(root: string, mediaFile?: string) {
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env: {
      ...environment,
      LINK_STUDIO_TEST_USER_DATA: root,
      LINK_STUDIO_TEST_PROJECT_PARENT: root,
      ...(mediaFile ? { LINK_STUDIO_TEST_MEDIA_FILES: mediaFile } : {}),
    },
  });
}

async function chooseCanvasFiles(page: Page, trigger: Locator, files: string[]) {
  const chooser = page.waitForEvent("filechooser");
  await trigger.click();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  expect(await picker.element().getAttribute("accept")).toBe("image/*,video/*,audio/*");
  await picker.setFiles(files);
}

test("画布底纹和滚轮偏好即时生效、重开保留并可恢复默认", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-view-prefs-"));
  let application = await launchCanvas(root);
  try {
    let page = await application.firstWindow();
    await createCanvasProject(page, "底纹回放");
    const settings = async () => {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await page.getByRole("menuitem", { name: "画布设置" }).click();
      return page.getByRole("dialog", { name: "画布设置" });
    };
    const view = () =>
      page.locator(".react-flow__viewport").evaluate((el) => {
        const matrix = new DOMMatrix(getComputedStyle(el).transform);
        return { x: matrix.e, y: matrix.f, zoom: matrix.a };
      });
    const wheel = async (horizontal: number, vertical: number) => {
      await page.mouse.move(110, 135);
      await page.mouse.wheel(horizontal, vertical);
    };
    let dialog = await settings();
    const choose = (label: string) => dialog.getByRole("button", { name: label, exact: true });
    const pattern = () => page.locator(".react-flow__background pattern");
    await expect(choose("点阵")).toHaveAttribute("aria-pressed", "true");
    await expect(choose("平移画布")).toHaveAttribute("aria-pressed", "true");
    for (const [label, selector] of [
      ["线条", "path.lines"],
      ["十字", "path.cross"],
      ["点阵", "circle"],
    ] as const) {
      await choose(label).click();
      await expect(pattern().locator(selector)).toHaveCount(1);
    }
    await choose("无").click();
    await expect(pattern()).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const before = await view();
    await wheel(0, 75);
    await expect.poll(async () => (await view()).y).not.toBe(before.y);
    await wheel(65, 0);
    await expect.poll(async () => (await view()).x).not.toBe(before.x);
    expect((await view()).zoom).toBe(before.zoom);
    dialog = await settings();
    await choose("十字").click();
    await choose("缩放画布").click();
    await choose("关闭").click();
    await expect(dialog).toHaveCount(0);
    await wheel(0, -90);
    await expect.poll(async () => (await view()).zoom).toBeGreaterThan(before.zoom);
    await application.close();
    application = await launchCanvas(root);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /^底纹回放/ }).click();
    dialog = await settings();
    await expect(choose("十字")).toHaveAttribute("aria-pressed", "true");
    await expect(choose("缩放画布")).toHaveAttribute("aria-pressed", "true");
    await choose("恢复默认").click();
    await expect(choose("平移画布")).toHaveAttribute("aria-pressed", "true");
    await expect(pattern().locator("circle")).toHaveAttribute("r", "1");
    await page.mouse.click(1, 1);
    await expect(dialog).toHaveCount(0);
    const restored = await view();
    await page.keyboard.down("Control");
    try {
      await wheel(0, 80);
    } finally {
      await page.keyboard.up("Control");
    }
    await expect.poll(async () => (await view()).zoom).toBeLessThan(restored.zoom);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("画布快捷键的三个入口、模态键盘隔离和焦点恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-shortcuts-"));
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "快捷键回放");
    await page.getByRole("button", { name: /^视频生成 文生、参考/ }).click();
    const selected = page.locator(".react-flow__node.selected"),
      id = await selected.getAttribute("data-id");
    const trigger = page.getByRole("button", { name: "快捷键", exact: true }),
      dialog = page.getByRole("dialog", { name: "快捷键" });
    await trigger.press("Enter");
    await expect(dialog.locator("dt")).toHaveCount(13);
    await expect(dialog.locator("kbd")).toHaveCount(13);
    await expect(dialog.locator("kbd").first()).toHaveText(
      process.platform === "darwin" ? "⌘↵" : "Ctrl+↵",
    );
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("h");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(selected).toHaveAttribute("data-id", id!);
    await expect(page.getByRole("radio", { name: "抓手", exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "快捷键" }).click();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await trigger.focus();
    await page.keyboard.press("?");
    await expect(dialog).toBeVisible();
    await page.locator(".storyboard-backdrop").click({ position: { x: 32, y: 120 } });
    await expect(dialog).toHaveCount(0);
    const prompt = page.locator("[data-node-prompt][contenteditable=true]");
    await prompt.click();
    await page.keyboard.press("?");
    await expect(prompt).toContainText("?");
    await expect(dialog).toHaveCount(0);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("左侧主工具栏、任务历史和空格拖动中松开的恢复顺序", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-edit-tools-")),
    app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page, "左栏回放");
    const tools = page.getByRole("toolbar", { name: "画布编辑" }),
      area = page.getByRole("region", { name: "节点画布" });
    await expect(tools.getByRole("button")).toHaveCount(5);
    await expect(tools.getByRole("radio")).toHaveCount(2);
    await expect(tools.getByRole("button", { name: "撤销" })).toBeDisabled();
    await addCanvasNode(page, "视频生成");
    await tools.getByRole("button", { name: "任务历史" }).click();
    const sheet = page.getByRole("dialog", { name: "任务历史" });
    await expect(sheet.getByText("这张画布还没有生成过内容。")).toBeVisible();
    await sheet.getByRole("button", { name: "Close" }).press("Backspace");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    const select = tools.getByRole("radio", { name: "选择" });
    await select.focus();
    await page.keyboard.down("Space");
    await expect(area).toHaveAttribute("data-hand", "true");
    await expect(select).toBeChecked();
    const card = page.locator(".creative-card"),
      before = await card.boundingBox();
    if (!before) throw Error("缺少节点");
    const point = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 24, point.y + 16, { steps: 4 });
    await page.keyboard.up("Space");
    await expect(area).toHaveAttribute("data-hand", "true");
    await page.mouse.move(point.x + 54, point.y + 36, { steps: 4 });
    await page.mouse.up();
    await expect(area).toHaveAttribute("data-hand", "false");
    expect((await card.boundingBox())!.x - before.x).toBeCloseTo(54, 0);
    await tools.getByRole("button", { name: "资产库" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await projectAction(page, "项目文件");
    await expect(page.getByRole("region", { name: "项目文件" })).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("左上角画布名称原位提交和放弃，新建前保存并从项目列表恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-canvas-project-bar-")),
    app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page, "场记初稿");
    const title = page.getByRole("textbox", { name: "画布名称" }),
      status = page.getByRole("status", { name: "已保存", exact: true });
    await expect(title).toHaveValue("场记初稿");
    await expect(status).toBeVisible();
    await expect(status.locator("span")).toHaveCount(0);
    await title.fill("放弃的名字");
    await title.press("Escape");
    await expect(title).toHaveValue("场记初稿");
    await title.fill("  场记定稿  ");
    await title.press("Enter");
    await expect(title).toHaveValue("场记定稿");
    await expect.poll(async () => (await latestSnapshot(root)).name).toBe("场记定稿");
    await title.fill("  ");
    await title.press("Tab");
    await expect(title).toHaveValue("场记定稿");
    await addCanvasNode(page, "文本");
    await projectAction(page, "新建画布项目");
    await expect(title).toHaveValue("未命名画布");
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await projectAction(page, "返回项目列表");
    await page.getByRole("button", { name: /^场记定稿/ }).click();
    await expect(title).toHaveValue("场记定稿");
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("视图工具条切换底纹、缩放、小地图并与设置同步", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-controls-"));
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "视图回放");
    await page.getByRole("button", { name: /^视频生成 文生、参考/ }).click();
    const view = page.getByRole("toolbar", { name: "画布视图" }),
      zoom = view.getByRole("button", { name: "缩放" }),
      map = view.getByRole("button", { name: "小地图" });
    const dots = view.getByRole("radio", { name: "点阵背景" }),
      none = view.getByRole("radio", { name: "无背景" });
    await none.click();
    await expect(none).toBeChecked();
    await expect(page.locator(".react-flow__background")).toHaveCount(0);
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "画布设置" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "无", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await dialog.getByRole("button", { name: "线条", exact: true }).click();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(none).not.toBeChecked();
    await expect(dots).not.toBeChecked();
    await dots.click();
    await expect(dots).toBeChecked();
    await expect(page.locator(".react-flow__background")).toBeVisible();
    const scale = () =>
      page
        .locator(".react-flow__viewport")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    await map.click();
    const overview = page.locator(".react-flow__minimap");
    await expect(overview).toBeVisible();
    const overviewBox = (await overview.boundingBox())!,
      center = {
        x: overviewBox.x + overviewBox.width / 2,
        y: overviewBox.y + overviewBox.height / 2,
      };
    const pan = () =>
      page
        .locator(".react-flow__viewport")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).e);
    const initialPan = await pan(),
      initialScale = await scale();
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 15, center.y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(pan).not.toBeCloseTo(initialPan);
    await page.mouse.wheel(0, -30);
    await expect.poll(scale).toBeGreaterThan(initialScale);
    await map.click();
    await expect(overview).toHaveCount(0);
    await zoom.press("Enter");
    await expect(page.getByRole("menuitem")).toHaveCount(4);
    await page.keyboard.press("Escape");
    await expect(zoom).toBeFocused();
    await chooseCanvasZoom(page, "缩放到 100%");
    await expect.poll(scale).toBeCloseTo(1, 4);
    await chooseCanvasZoom(page, "缩小");
    await expect.poll(scale).toBeCloseTo(1 / 1.2, 4);
    await chooseCanvasZoom(page, "放大");
    await expect.poll(scale).toBeCloseTo(1, 4);
    await chooseCanvasZoom(page, "适应画布");
    await expect.poll(scale).not.toBeCloseTo(1, 2);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("画布通用设置和更多菜单共用主题，旧偏好迁移、重启和恢复默认", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-view-theme-"));
  let application: ElectronApplication | undefined;
  try {
    await mkdir(join(root, "settings"));
    const old = new DatabaseSync(join(root, "settings", "settings.sqlite"));
    try {
      old.exec(
        "CREATE TABLE canvas_view(id INTEGER PRIMARY KEY,background TEXT NOT NULL,wheel_mode TEXT NOT NULL);INSERT INTO canvas_view VALUES(1,'cross','zoom')",
      );
    } finally {
      old.close();
    }
    application = await launchCanvas(root);
    let page = await application.firstWindow();
    await page.emulateMedia({ colorScheme: null });
    await createCanvasProject(page, "主题回放");
    const preferences = () =>
      page.evaluate(async () => {
        const result = await window.desktop.settings.canvasView({});
        if (!result.ok) throw new Error(result.code);
        return result.value;
      });
    const scheme = () => page.evaluate(() => matchMedia("(prefers-color-scheme:dark)").matches);
    const more = () => page.getByRole("button", { name: "更多", exact: true }).click();
    const openSettings = async () => {
      await more();
      await page.getByRole("menuitem", { name: "画布设置" }).click();
    };
    const themeMenu = async () => {
      await more();
      await page.getByRole("menuitem", { name: "主题", exact: true }).press("ArrowRight");
    };
    const button = (label: string) =>
      page.getByRole("dialog").getByRole("button", { name: label, exact: true });
    await expect.poll(scheme).toBe(true);
    expect(await preferences()).toEqual({
      background: "cross",
      wheelMode: "zoom",
      theme: "dark",
      showHints: true,
      defaultModels: {},
    });
    const credit = page.getByRole("button", { name: "积分，实时进度未连接" });
    await credit.press("Enter");
    await expect(page.getByRole("dialog", { name: "积分余额" }).locator("dd")).toHaveText([
      "—",
      "—",
    ]);
    await page.keyboard.press("Escape");
    await expect(credit).toBeFocused();
    const account = page.getByRole("button", { name: "账户", exact: true });
    await account.click();
    await expect(page.getByRole("menuitem", { name: "退出登录" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(account).toBeFocused();
    await page.getByRole("button", { name: "更多", exact: true }).hover();
    await expect(page.locator(".canvas-more-tip")).toHaveText("更多");
    await openSettings();
    await button("通用设置").click();
    await button("浅色").click();
    await expect.poll(scheme).toBe(false);
    await page.getByRole("switch", { name: "操作提示" }).press("Space");
    await expect(page.getByRole("switch")).not.toBeChecked();
    await page.keyboard.press("Escape");
    await themeMenu();
    await expect(page.getByRole("menuitemradio", { name: "浅色" })).toBeChecked();
    await page.getByRole("menuitemradio", { name: "跟随系统" }).click();
    await expect
      .poll(() => application!.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("system");
    await expect
      .poll(scheme)
      .toBe(await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors));
    await expect(page.getByRole("menuitemradio", { name: "跟随系统" })).toBeChecked();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("menuitem", { name: "主题", exact: true })).toBeFocused();
    await page.getByRole("menuitem", { name: "画布设置" }).click();
    await expect(button("跟随系统")).toHaveAttribute("aria-pressed", "true");
    await button("浅色").click();
    await expect.poll(scheme).toBe(false);
    await application.close();
    application = await launchCanvas(root);
    page = await application.firstWindow();
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getBackgroundColor().toLowerCase(),
      ),
    ).toBe("#ffffff");
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("button", { name: /^主题回放/ }).click();
    await openSettings();
    await button("通用设置").click();
    await expect(button("浅色")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("switch")).not.toBeChecked();
    await button("恢复默认").click();
    await expect.poll(scheme).toBe(true);
    await expect(page.getByRole("switch")).toBeChecked();
    await expect(button("深色")).toHaveAttribute("aria-pressed", "true");
    expect(await preferences()).toEqual({
      background: "dots",
      wheelMode: "pan",
      theme: "dark",
      showHints: true,
      defaultModels: {},
    });
    await button("关闭").click();
    await themeMenu();
    await expect(page.getByRole("menuitemradio", { name: "深色" })).toBeChecked();
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function holdCanvasFile(
  app: ElectronApplication,
  phase: "secondChunk" | "sync" | "failSync",
) {
  await app.evaluate((_, phase) => {
    const filesystem = process.getBuiltinModule("fs/promises"),
      modules = process.getBuiltinModule("module");
    const open = filesystem.open;
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const restore = () => {
      filesystem.open = open;
      modules.syncBuiltinESMExports();
    };
    (globalThis as { releaseCanvasWrite?: () => void }).releaseCanvasWrite = () => {
      restore();
      resume();
    };
    filesystem.open = async (...args) => {
      const handle = await open(...args);
      if (typeof args[0] === "string" && args[0].endsWith(".asset") && args[1] === "wx+") {
        restore();
        if (phase === "sync" || phase === "failSync")
          handle.sync = new Proxy(handle.sync, {
            async apply(method, receiver, parameters) {
              await wait;
              if (phase === "failSync") throw Error("fixture disk write failed");
              return Reflect.apply(method, receiver, parameters);
            },
          });
        else
          handle.write = new Proxy(handle.write, {
            async apply(method, receiver, parameters) {
              if (parameters[3] === 1024 * 1024) await wait;
              return Reflect.apply(method, receiver, parameters);
            },
          });
      }
      return handle;
    };
    modules.syncBuiltinESMExports();
  }, phase);
}

function releaseCanvasFile(app: ElectronApplication) {
  return app.evaluate(() => {
    (globalThis as { releaseCanvasWrite?: () => void }).releaseCanvasWrite?.();
  });
}

function installVideoChoices(page: Page) {
  return page.evaluate(async () => {
    const settings = window.desktop.settings;
    const list = await settings.list({});
    if (!list.ok) throw new Error(list.code);
    const plugin = list.value.plugins.find((entry) => entry.key === "sora");
    if (!plugin) throw new Error("Sora missing");
    const ids: Record<string, string> = {};
    for (const model of ["sora-2", "sora-2-pro"]) {
      const result = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-only",
        fields: {
          label: model,
          endpoint: "https://example.invalid",
          model,
          agentEnabled: false,
          allowLocal: false,
          channel: {},
        },
      });
      if (!result.ok) throw new Error(result.code);
      ids[model] = result.value.id;
    }
    return ids;
  });
}

test("模型设置只决定新节点的模型，重启保留、恢复默认不改旧节点", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-canvas-model-prefs-"));
  let application = await launchCanvas(root);
  try {
    let page = await application.firstWindow();
    const providers = await installVideoChoices(page);
    await createCanvasProject(page, "默认模型回放");
    const show = async () => {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await page.getByRole("menuitem", { name: "画布设置" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "新节点默认模型", exact: true })
        .click();
    };
    const picker = () => page.getByRole("button", { name: "选择视频节点的默认模型" });
    const nodeModel = () => page.getByRole("button", { name: "选择模型", exact: true });
    await page.getByRole("button", { name: /^视频生成 文生、参考/ }).click();
    await expect(nodeModel()).toHaveText(/sora-2/);
    const first = await nodeModel().innerText();
    const next = first === "sora-2" ? "sora-2-pro" : "sora-2";
    await show();
    await expect(picker()).toHaveText(first);
    await picker().press("Enter");
    await page
      .getByRole("menuitemradio")
      .filter({ has: page.getByText(next, { exact: true }) })
      .click();
    await page.keyboard.press("Escape");
    await expect(picker()).toBeFocused();
    await expect(picker()).toHaveText(next);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(nodeModel()).toHaveText(first);
    await addCanvasNode(page, "视频生成");
    await expect(nodeModel()).toHaveText(next);
    const seeded = await page.locator(".react-flow__node.selected").getAttribute("data-id");
    const disk = async () =>
      projectCanvas((await latestSnapshot(root)).canvas).nodes.flatMap((node) =>
        node.type === "creative" && node.data.kind === "video"
          ? [node.data.generation?.providerId ?? null]
          : [],
      );
    await expect.poll(disk).toEqual([null, providers[next]]);
    await application.close();
    application = await launchCanvas(root);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /^默认模型回放/ }).click();
    await show();
    await expect(picker()).toHaveText(next);
    await page.getByRole("button", { name: "恢复默认" }).click();
    await expect(picker()).toHaveText(first);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await addCanvasNode(page, "视频生成");
    await expect(nodeModel()).toHaveText(first);
    await expect.poll(disk).toEqual([null, providers[next], null]);
    expect(
      projectCanvas((await latestSnapshot(root)).canvas).nodes.some((node) => node.id === seeded),
    ).toBe(true);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("默认视频模型下线后新节点不写入过期选择，已有节点提示下线", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-canvas-offline-default-"));
  let application = await launchCanvas(root);
  try {
    let page = await application.firstWindow();
    const providers = await installVideoChoices(page);
    await createCanvasProject(page, "模型下线回放");
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "画布设置" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "新节点默认模型", exact: true })
      .click();
    await page.getByRole("button", { name: "选择视频节点的默认模型" }).click();
    await page
      .getByRole("menuitemradio")
      .filter({ has: page.getByText("sora-2-pro", { exact: true }) })
      .click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: /^视频生成 文生、参考/ }).click();
    const selected = await page.locator(".react-flow__node.selected").getAttribute("data-id");
    const bindings = async () =>
      projectCanvas((await latestSnapshot(root)).canvas).nodes.flatMap((node) =>
        node.type === "creative" && node.data.kind === "video"
          ? [node.data.generation?.providerId ?? null]
          : [],
      );
    const model = providers["sora-2-pro"]!;
    await expect.poll(bindings).toEqual([model]);
    await page.evaluate(async (id) => {
      const settings = window.desktop.settings;
      const state = await settings.list({});
      if (!state.ok) throw Error(state.code);
      const revision = state.value.providers.find((provider) => provider.id === id)!.revision;
      const disabled = await settings.disable({ id, expectedRevision: revision });
      if (!disabled.ok) throw Error(disabled.code);
    }, model);
    await application.close();
    application = await launchCanvas(root);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /^模型下线回放/ }).click();
    await page.locator(`.react-flow__node[data-id="${selected}"]`).click();
    const trigger = page.getByRole("button", { name: "选择模型", exact: true });
    await expect(trigger).toHaveText("模型已下线");
    await expect(page.getByRole("button", { name: "开始生成" })).toBeDisabled();
    await addCanvasNode(page, "视频生成");
    await expect(trigger).toHaveText("sora-2");
    await expect.poll(bindings).toEqual([model, null]);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("节点模型和生成参数支持撤销重做、切换选区与重开", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-canvas-model-draft-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    const providers = await installVideoChoices(page);
    await createCanvasProject(page, "节点配置回放");
    await page.getByRole("button", { name: /^视频生成 文生、参考/ }).click();
    const nodeId = (await page.locator(".react-flow__node.selected").getAttribute("data-id"))!;
    await expect(page.getByRole("toolbar", { name: /的功能区$/ })).toHaveCount(0);
    const modes = page.getByRole("tablist", { name: "生成方式" });
    await expect(modes.getByRole("tab", { name: "文生视频" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const placement = await page
      .locator(".react-flow__node.selected .creative-card")
      .evaluate((card) => {
        const bounds = card.getBoundingClientRect();
        const projectBar = document.querySelector(".canvas-project-zone")!.getBoundingClientRect();
        return {
          horizontalOffset: bounds.x + bounds.width / 2 - innerWidth / 2,
          verticalOffset: bounds.y + bounds.height / 2 - innerHeight * 0.4,
          projectBarClearance: bounds.top - projectBar.bottom,
        };
      });
    expect(Math.abs(placement.horizontalOffset)).toBeLessThan(1);
    expect(Math.abs(placement.verticalOffset)).toBeLessThan(1);
    expect(placement.projectBarClearance).toBeGreaterThan(0);
    await expect(modes.getByRole("tab", { name: "图生视频" })).toHaveAttribute(
      "title",
      "需要连接图片节点",
    );
    await page.getByRole("button", { name: "放大编辑提示词" }).click();
    await expect(page.getByRole("dialog", { name: "编辑提示词" })).toBeVisible();
    await expect(modes).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(modes.getByRole("tab", { name: "文生视频" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const trigger = page.getByRole("button", { name: "选择模型" });
    const initial = await trigger.innerText();
    const next = initial === "sora-2" ? "sora-2-pro" : "sora-2";
    const disk = async () => {
      const node = projectCanvas((await latestSnapshot(root)).canvas).nodes.find(
        (entry) => entry.id === nodeId,
      );
      return node?.type === "creative" ? node.data.generation : undefined;
    };
    await trigger.click();
    await page
      .getByRole("menu", { name: "选择模型" })
      .getByRole("menuitemradio")
      .filter({ has: page.getByText(next, { exact: true }) })
      .click();
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveText(next);
    await expect.poll(async () => (await disk())?.providerId).toBe(providers[next]);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(trigger).toHaveText(initial);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(trigger).toHaveText(next);
    const params = page.getByRole("button", { name: "生成参数", exact: true });
    await params.click();
    await page.getByRole("radio", { name: "8秒", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await disk())?.params?.duration).toBe(8);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(params).not.toContainText("8秒");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(params).toContainText("8秒");
    const card = page.locator(`.react-flow__node[data-id="${nodeId}"] .creative-card`);
    await expect(card).toHaveCSS("width", "576px");
    await params.click();
    await page.getByRole("radio", { name: "9:16", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCSS("width", "324px");
    await expect(card).toHaveCSS("height", "576px");
    await expect.poll(async () => (await disk())?.params?.size).toBe("720x1280");
    const pane = page.locator(".react-flow__pane");
    await pane.dblclick({ position: { x: (await pane.boundingBox())!.width - 90, y: 100 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "文本", exact: true })
      .click();
    await card.click({ position: { x: 40, y: 180 } });
    await expect(params).toContainText("8秒");
    await expect(trigger).toHaveText(next);
    await expect.poll(async () => (await disk())?.params?.duration).toBe(8);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^节点配置回放/ }).click();
    const reopenedCard = reopened.locator(`.react-flow__node[data-id="${nodeId}"] .node-media`);
    await reopenedCard.click({ position: { x: 40, y: 180 } });
    await expect(reopened.getByRole("button", { name: "选择模型" })).toHaveText(next);
    await expect(
      reopened.locator(`.react-flow__node[data-id="${nodeId}"] .creative-card`),
    ).toHaveCSS("height", "576px");
    await expect(reopened.getByRole("button", { name: "生成参数", exact: true })).toContainText(
      "8秒",
    );
    await projectAction(reopened, "关闭项目");
    await reopened.evaluate(async (id) => {
      const list = await window.desktop.settings.list({});
      if (!list.ok) throw new Error(list.code);
      const selected = list.value.providers.find((entry) => entry.id === id)!;
      const disabled = await window.desktop.settings.disable({
        id,
        expectedRevision: selected.revision,
      });
      if (!disabled.ok) throw new Error(disabled.code);
    }, providers[next]!);
    await reopened.getByRole("button", { name: /^节点配置回放/ }).click();
    await reopenedCard.click({ position: { x: 40, y: 180 } });
    await expect(reopened.getByRole("button", { name: "选择模型" })).toHaveText("模型已下线");
    await expect(reopened.getByRole("alert")).toContainText("这个模型已经下线");
    await reopened.getByRole("textbox", { name: "生成提示词" }).fill("检验下线而非空提示词");
    await expect(reopened.getByRole("button", { name: "开始生成" })).toBeDisabled();
    expect((await disk())?.providerId).toBe(providers[next]);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("导入画布仅按本机模型键恢复配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-canvas-model-import-"));
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    const providers = await installVideoChoices(page);
    const model = "sora-2";
    await createCanvasProject(page, "模型键回放");
    const exchange = join(root, "foreign.canvas.json");
    await writeFile(
      exchange,
      JSON.stringify({
        format: "video-canvas/canvas",
        version: 1,
        canvas: {
          title: "模型键",
          edges: [],
          nodes: [
            {
              id: "foreign-node",
              type: "canvas",
              position: { x: 1200, y: 0 },
              data: {
                kind: "video",
                label: "外来模型",
                model,
                params: { duration: 4, prompt: "模型同名不等于同一配置" },
              },
            },
            {
              id: "known-node",
              type: "canvas",
              position: { x: 1900, y: 0 },
              data: {
                kind: "video",
                label: "已知模型",
                model: providers[model],
                params: { duration: 12, prompt: "使用本机模型键" },
              },
            },
          ],
        },
        assets: {},
      }),
    );
    await page
      .locator('input[type="file"][accept=".json,application/json"]')
      .setInputFiles(exchange);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await chooseCanvasZoom(page, "适应画布");
    await page
      .locator("header strong")
      .filter({ hasText: /^外来模型$/ })
      .click();
    await expect(page.getByRole("button", { name: "选择模型" })).toHaveText("模型已下线");
    await page
      .locator("header strong")
      .filter({ hasText: /^已知模型$/ })
      .click();
    await expect(page.getByRole("button", { name: "选择模型" })).toHaveText(model);
    await expect(page.getByRole("button", { name: "生成参数", exact: true })).toContainText("12秒");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("资产库按选择顺序引入混合画幅、整批撤销并重开", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-asset-picker-"));
  const ffmpeg = join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg");
  const files = ["竖.png", "声.wav", "宽.png", "景.mp4", "方.png"].map((name) => join(root, name));
  let application = await launchCanvas(root);
  try {
    const codec =
      process.platform === "darwin"
        ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
        : ["-c:v", "libx264"];
    const args = [
      ["color=c=red:s=32x64", "-frames:v", "1"],
      ["sine=frequency=440:sample_rate=8000", "-t", "1"],
      ["color=c=blue:s=64x32", "-frames:v", "1"],
      ["color=c=black:s=64x48", "-frames:v", "2", ...codec],
      ["color=c=yellow:s=32x32", "-frames:v", "1"],
    ];
    for (const [index, input] of args.entries())
      await runMediaProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", ...input, files[index]!]);
    const page = await application.firstWindow();
    await createCanvasProject(page, "资产批量");
    const library = page.getByRole("button", { name: "资产库", exact: true });
    await library.click();
    const picker = page.getByRole("dialog", { name: "资产库" });
    const confirm = picker.getByRole("button", { name: "确认", exact: true });
    await expect(confirm).toBeDisabled();
    const chooser = page.waitForEvent("filechooser");
    await picker.getByRole("button", { name: "上传", exact: true }).click();
    await (await chooser).setFiles(files);
    await expect(picker.getByText("已选择 5 个素材")).toBeVisible();
    await expect(confirm).toBeEnabled();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await picker.getByRole("tab", { name: "生成历史" }).click();
    await picker.getByRole("button", { name: "视频", exact: true }).click();
    await expect(picker.getByText("暂无相关资产")).toBeVisible();
    await expect(picker.getByRole("list", { name: "已选素材" }).getByRole("button")).toHaveCount(5);
    await picker.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await library.click();
    const duplicateChooser = page.waitForEvent("filechooser");
    await picker.getByRole("button", { name: "上传", exact: true }).click();
    await (await duplicateChooser).setFiles(files[0]!);
    await expect(picker.getByRole("group", { name: "处理重复素材" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(library).toBeEnabled();
    await library.click();
    await expect(picker.locator(".asset-pick-card")).toHaveCount(5);
    await expect(confirm).toBeDisabled();
    await picker.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: /^文本 脚本、分镜描述/ }).click();
    const source = page.locator(".react-flow__node");
    await source
      .locator(".react-flow__handle-right")
      .dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 250, y: 190 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "从资产库添加" })
      .click();
    await expect(confirm).toBeDisabled();
    const search = picker.getByRole("textbox", { name: "搜索文件名" });
    await search.fill("方");
    await picker.getByRole("button", { name: "方.png", exact: true }).click();
    await search.fill("");
    for (const name of ["竖.png", "声.wav", "宽.png", "景.mp4"])
      await picker.getByRole("button", { name, exact: true }).click();
    await picker.getByRole("button", { name: "取消选择 方.png" }).click();
    await picker.getByRole("button", { name: "方.png", exact: true }).click();
    await confirm.click();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(5);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    const snapshot = async () =>
      projectCanvas((await latestSnapshot(root)).canvas).nodes.filter(
        (node) => node.type === "creative" && node.data.uploaded,
      );
    await expect.poll(async () => (await snapshot()).length).toBe(5);
    const placed = await snapshot();
    const origin = placed[0]!.position;
    expect(
      placed.map((node) => [
        node.data.label,
        node.position.x - origin.x,
        node.position.y - origin.y,
      ]),
    ).toEqual([
      ["竖", 0, 0],
      ["声", 364, 0],
      ["宽", 728, 0],
      ["景", 1416, 0],
      ["方", 0, 688],
    ]);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(source).toHaveCount(1);
    await expect.poll(snapshot).toHaveLength(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(snapshot).toEqual(placed);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^资产批量/ }).click();
    await expect(reopened.locator(".react-flow__node")).toHaveCount(6);
    await expect.poll(snapshot).toEqual(placed);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("音频波形支持定位、续播和失选暂停", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-audio-wave-"));
  const clip = join(root, "音轨.wav");
  const samples = Buffer.alloc(44 + 8000 * 2 * 8);
  samples.write("RIFF");
  samples.writeUInt32LE(samples.length - 8, 4);
  samples.write("WAVEfmt ", 8);
  samples.writeUInt32LE(16, 16);
  samples.writeUInt16LE(1, 20);
  samples.writeUInt16LE(1, 22);
  samples.writeUInt32LE(8000, 24);
  samples.writeUInt32LE(16000, 28);
  samples.writeUInt16LE(2, 32);
  samples.writeUInt16LE(16, 34);
  samples.write("data", 36);
  samples.writeUInt32LE(samples.length - 44, 40);
  for (let index = 16000; index < 64000; index++)
    samples.writeInt16LE(
      Math.round((Math.sin((index * Math.PI) / 8) * 24000 * index) / 64000),
      44 + index * 2,
    );
  await writeFile(clip, samples);
  const application = await launchCanvas(root, clip);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page);
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    await expect(page.getByRole("button", { name: "将音轨.wav加入画布" })).toBeVisible();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await page.getByRole("button", { name: /^文本 脚本、分镜描述/ }).click();
    await page
      .locator(".react-flow__handle-right")
      .dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 250, y: 190 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "音频", exact: true })
      .click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    const emptyNode = page.locator(".react-flow__node.selected");
    const nodeId = await emptyNode.getAttribute("data-id");
    await expect(emptyNode.getByRole("img", { name: "选中后输入提示词生成音频" })).toBeVisible();
    const panel = page.getByRole("region", { name: "生成确认" });
    const modelTrigger = panel.getByRole("button", { name: "选择模型" });
    await expect(modelTrigger).toHaveText("暂无可用模型");
    await modelTrigger.press("Enter");
    const modelMenu = page.getByRole("menu", { name: "选择模型" });
    await expect(modelMenu).toBeVisible();
    await expect(modelMenu.getByRole("menuitemradio")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(modelMenu).toBeHidden();
    await expect(modelTrigger).toBeFocused();
    await expect(panel.getByRole("button", { name: "运镜" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "生成参数" })).toHaveCount(0);
    const panelBox = (await panel.boundingBox())!;
    const cardBox = (await emptyNode.boundingBox())!;
    const flowBox = (await page.locator(".react-flow").boundingBox())!;
    expect(panelBox.width).toBe(Math.min(680, flowBox.width - 24));
    expect(Math.abs(panelBox.y - cardBox.y - cardBox.height - 16)).toBeLessThan(1);
    expect(panelBox.x - flowBox.x).toBeGreaterThanOrEqual(11.5);
    expect(flowBox.x + flowBox.width - panelBox.x - panelBox.width).toBeGreaterThanOrEqual(11.5);
    await panel.getByRole("textbox", { name: "生成提示词" }).fill("低沉男声");
    await expect(panel.locator(".media-prompt-count")).toHaveText("4/16000");
    const expand = panel.getByRole("button", { name: "放大编辑提示词" });
    await expand.click();
    const edit = page.getByRole("dialog", { name: "编辑提示词" });
    const prompt = edit.getByRole("textbox", { name: "生成提示词" });
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveText("低沉男声");
    expect((await edit.boundingBox())!.width).toBe(896);
    expect((await prompt.boundingBox())!.height).toBe(288);
    await edit.getByRole("button", { name: "引用画布里的素材" }).click();
    await expect(edit.getByRole("menu", { name: "引用画布里的素材" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(edit.getByRole("menu")).toHaveCount(0);
    await expect(edit).toBeVisible();
    await prompt.press("End");
    await prompt.press("Enter");
    await page.keyboard.insertText("第二句");
    await expect(edit.locator(".media-prompt-count")).toHaveText("8/16000");
    await prompt.press("Escape");
    await expect(edit).toHaveCount(0);
    await expect(expand).toBeFocused();
    await expect(panel.getByRole("textbox", { name: "生成提示词" })).toContainText("第二句");
    await emptyNode.getByRole("button", { name: "从资产库选取素材" }).click();
    const picker = page.getByRole("dialog", { name: "资产库" });
    await picker.getByRole("button", { name: "音轨.wav", exact: true }).click();
    await expect(emptyNode.locator("audio")).toHaveCount(0);
    await picker.getByRole("button", { name: "放进节点" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(
      page.locator(".react-flow__node").filter({ has: page.locator("audio") }),
    ).toHaveAttribute("data-id", nodeId!);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    const card = page.locator(".creative-card").filter({ has: page.locator("audio") });
    const wave = card.locator('[data-slot="audio-wave"]');
    const player = card.locator("audio");
    const head = wave.getByRole("slider");
    await expect(card.locator(".react-flow__handle.target")).toBeHidden();
    await expect(card.locator(".react-flow__handle.source")).toBeVisible();
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(page.locator("audio")).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await expect(card).toHaveCSS("height", "324px");
    await expect(wave.locator(".node-audio-bar")).toHaveCount(56);
    await expect(wave.locator(".node-audio-bar").first()).toHaveCSS("height", "2px");
    await expect
      .poll(() =>
        wave
          .locator(".node-audio-bar")
          .last()
          .evaluate((el) => el.clientHeight),
      )
      .toBeGreaterThan(200);
    await expect(head).toHaveAttribute("aria-valuemax", "8");
    await head.press("ArrowRight");
    await expect(card.locator(".node-audio-time")).toHaveText("00:00:01");
    await head.press("ArrowLeft");
    await expect(card.locator(".node-audio-time")).toHaveText("00:00:00");
    await card.getByRole("button", { name: "播放", exact: true }).click();
    await expect(player).toHaveJSProperty("paused", false);
    const bounds = (await wave.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await expect(player).toHaveJSProperty("paused", true);
    await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height / 2);
    await expect(head).toHaveAttribute("aria-valuenow", "4");
    await page.mouse.up();
    await expect(player).toHaveJSProperty("paused", false);
    await card.locator("header strong").click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
    await expect(player).toHaveJSProperty("paused", true);
    expect(await player.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(
      4,
    );
    await card.locator("header strong").click();
    await player.evaluate((audio: HTMLAudioElement) => {
      audio.currentTime = audio.duration - 0.15;
    });
    await card.getByRole("button", { name: "播放", exact: true }).click();
    await expect(head).toHaveAttribute("aria-valuenow", "0");
    await expect(player).toHaveJSProperty("currentTime", 0);
    await expect(player).toHaveJSProperty("paused", true);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("批量生成首张解锁主图和连线，后续失败不覆盖已选旧版", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "link-edge-batch-"));
  const replies: Array<(png?: Buffer) => void> = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/images/generations")
      return void response.writeHead(404).end();
    request.resume();
    request.on("end", () =>
      replies.push((png) =>
        png
          ? response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }))
          : response.writeHead(400).end(JSON.stringify({ error: { message: "第二份失败" } })),
      ),
    );
  });
  const app = await launchCanvas(root);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("缺少测试地址");
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    await page.evaluate(async (endpoint) => {
      const api = window.desktop.settings,
        list = await api.list({});
      const plugin = list.ok && list.value.plugins.find((item) => item.key === "openai-image");
      if (!plugin) throw new Error("缺少生图适配器");
      const channel = await api.channelSave({
        approve: true,
        expectedRevision: 0,
        secret: "fixture-key",
        fields: {
          name: "本地批量测试",
          endpoint,
          enabled: true,
          allowLocal: true,
          sort: 1,
          headers: [],
        },
      });
      if (!channel.ok) throw new Error(channel.code);
      const model = await api.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        upstreamModel: "gpt-image-1",
        pluginHash: plugin.hash,
        enabled: true,
        approve: true,
        settings: {},
        config: {
          kind: "image",
          name: "批量生图",
          description: "",
          sort: 1,
          modes: ["t2i"],
          params: {
            count: { values: ["1", "2"], default: "1", open: true, fanout: true, unit: "张" },
          },
        },
      });
      if (!model.ok) throw new Error(model.code);
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page, "连线批量");
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles({
      name: "batch.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "link-studio.canvas",
          version: 1,
          title: "批量",
          exportedAt: "2026-01-01",
          nodes: [
            {
              id: "source",
              type: "creative",
              position: { x: 0, y: 0 },
              data: { kind: "script", label: "来源", text: "月台" },
            },
            {
              id: "target",
              type: "creative",
              position: { x: 580, y: 0 },
              data: { kind: "image", label: "两份出图", text: "清晨" },
            },
          ],
          edges: [{ id: "line", source: "source", target: "target" }],
          viewport: { x: 0, y: 0, zoom: 0.7 },
        }),
      ),
    });
    const card = page.locator("article[data-card-kind=image]"),
      sweep = page.locator(".react-flow__edge animateTransform"),
      start = page.getByRole("button", { name: "开始生成", exact: true });
    await card.click({ position: { x: 50, y: 55 } });
    await start.click();
    await expect.poll(() => replies.length).toBe(1);
    replies[0]!(await readFile("resources/icons/icon-32.png"));
    await expect(start).toBeEnabled();
    await page.getByRole("button", { name: "生成参数" }).click();
    await page.getByRole("radio", { name: "2张", exact: true }).click();
    await page.keyboard.press("Escape");
    await start.click();
    await expect.poll(() => replies.length).toBeGreaterThanOrEqual(2);
    const badge = card.getByRole("button", {
      name: "历史记录，共 3 版，还有任务在生成",
      exact: true,
    });
    await expect(sweep).toHaveAttribute("dur", "1.1s");
    await badge.click();
    const history = page.getByRole("dialog", { name: "历史记录", exact: true }),
      old = history.getByRole("button", { name: "第 1 版", exact: true });
    await expect(old).toHaveAttribute("title", "生成中，出第一张后可切换");
    await expect(history.locator(".version-pending")).toHaveCount(2);
    const checkpoints = [];
    const capture = async (step: string) => ({
      step,
      versions: await history.locator("[data-history-tile]").count(),
      pending: await history.locator(".version-pending").count(),
      adopted:
        (
          await history
            .locator("[aria-pressed=true][data-history-tile]")
            .getAttribute("aria-label", { timeout: 500 })
            .catch(() => null)
        )?.match(/第 (\d+) 版/)?.[1] ?? null,
      locked:
        (await history.locator("[data-history-tile]").first().getAttribute("title")) ===
        "生成中，出第一张后可切换",
      fast: (await sweep.getAttribute("dur")) === "1.1s",
    });
    checkpoints.push(await capture("submitted"));
    replies[1]!(await readFile("resources/icons/icon-64.png"));
    await expect(history.locator(".version-pending")).toHaveCount(1);
    await expect(history.getByRole("button", { name: "第 2 版（当前主图）" })).toBeVisible();
    await expect(sweep).toHaveAttribute("dur", "2.6s");
    checkpoints.push(await capture("first-result"));
    await old.click();
    await expect(history.getByRole("button", { name: "第 1 版（当前主图）" })).toBeVisible();
    await expect(card.getByRole("status")).toHaveCount(0);
    await expect(sweep).toHaveAttribute("dur", "2.6s");
    checkpoints.push(await capture("choose-old"));
    await expect.poll(() => replies.length).toBe(3);
    replies[2]!();
    await expect(history.locator(".version-failed")).toHaveCount(1);
    await expect(history.locator(".version-pending")).toHaveCount(0);
    await expect(history.getByRole("button", { name: "第 1 版（当前主图）" })).toBeVisible();
    checkpoints.push(await capture("last-failed"));
    await mkdir(test.info().outputDir, { recursive: true });
    await writeFile(test.info().outputPath("batch-versions.json"), JSON.stringify(checkpoints));
    await history.getByRole("button", { name: "全屏查看" }).click();
    await expect(
      page.getByRole("dialog", { name: "全屏查看" }).locator(".version-failed"),
    ).toHaveCount(0);
    await page
      .getByRole("dialog", { name: "全屏查看" })
      .getByRole("button", { name: "关闭" })
      .click();
    await expect(page.getByRole("dialog", { name: "全屏查看" })).toHaveCount(0);
    await history.getByRole("button", { name: "关闭" }).click();
    await expect(history).toHaveCount(0);
    await expect(start).toBeEnabled();
    await projectAction(page, "关闭项目");
    await page.getByRole("button", { name: /^连线批量/ }).click();
    await chooseCanvasZoom(page, "适应画布");
    await card.getByRole("button", { name: "历史记录，共 2 版", exact: true }).click();
    await expect(history.getByRole("button", { name: "第 1 版（当前主图）" })).toBeVisible();
    expect(replies).toHaveLength(3);
  } finally {
    server.closeAllConnections();
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("版本历史八版直接添加、九版确认、批量下载与重开", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "link-history-bulk-"));
  const paths = [32, 64].map((size) => join(process.cwd(), `resources/icons/icon-${size}.png`));
  const application = await launchCanvas(root, paths.join("\n"));
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "版本批量回放");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    await expect(page.getByRole("button", { name: "将icon-64.png加入画布" })).toBeVisible();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const state = await latestSnapshot(root),
      assets = Object.values(state.assets).sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      );
    expect(assets).toHaveLength(2);
    const outputs = Array.from({ length: 9 }, (_, index) => ({
      id: `result-${index + 1}`,
      assetId: assets[index % 2]!.assetId,
      kind: "image",
      createdAt: "2026-01-01T00:00:00Z",
    }));
    const imported = [8, 9].map((count, index) => ({
      id: `source-${count}`,
      type: "creative",
      position: { x: index * 650, y: 0 },
      data: {
        kind: "image",
        label: `样片${count}`,
        text: "原稿",
        outputs: outputs.slice(0, count),
        assetId: outputs[2]!.assetId,
        activeOutputId: outputs[2]!.id,
      },
    }));
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles({
      name: "history.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "link-studio.canvas",
          version: 1,
          title: "版本样片",
          exportedAt: "2026-01-01",
          nodes: imported,
          edges: [],
          viewport: { x: 0, y: 0, zoom: 0.8 },
        }),
      ),
    });
    const history = page.getByRole("dialog", { name: "历史记录", exact: true }),
      full = page.getByRole("dialog", { name: "全屏查看" });
    const copies = async () =>
      projectCanvas((await latestSnapshot(root)).canvas).nodes.flatMap((node) =>
        node.type === "creative" && node.data.label.includes(" · 版本") ? [node] : [],
      );
    const addFromMenu = async () => {
      await history.getByRole("button", { name: "更多" }).click();
      await page.getByRole("menuitem", { name: "全部添加到画布" }).click();
    };
    await expect(
      page.getByRole("button", { name: "历史记录，共 8 版", exact: true }),
    ).toBeAttached();
    await chooseCanvasZoom(page, "适应画布");
    await page.getByRole("button", { name: "历史记录，共 8 版", exact: true }).click();
    await addFromMenu();
    await expect.poll(async () => (await copies()).length).toBe(8);
    await history.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(copies).toEqual([]);
    await page.getByRole("button", { name: "历史记录，共 9 版", exact: true }).click();
    await addFromMenu();
    const question = page.getByRole("dialog", {
      name: "将在画布上新建 9 个节点，确定吗？",
      exact: true,
    });
    await expect(question.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
    expect(await copies()).toEqual([]);
    await history.getByRole("button", { name: "全屏查看" }).click();
    await full.getByRole("button", { name: "全部添加到画布" }).click();
    await question.getByRole("button", { name: "取消" }).click();
    await expect(full).toBeVisible();
    expect(await copies()).toEqual([]);
    const tile = full.getByRole("button", { name: "第 2 版", exact: true });
    await tile.hover();
    const copiedImage = test.info().outputPath("copied.png");
    await application.evaluate(({ clipboard }, path) => {
      clipboard.write = async (items) => {
        const image = await items[0]!.getType("image/png");
        await process
          .getBuiltinModule("fs/promises")
          .writeFile(path, Buffer.from(await image.arrayBuffer()));
      };
    }, copiedImage);
    await tile.getByRole("button", { name: "复制图片" }).click();
    await expect(page.getByText("已复制图片", { exact: true })).toBeVisible();
    expect(await readFile(copiedImage)).toEqual(await readFile(paths[1]!));
    await application.evaluate(({ clipboard }) => {
      clipboard.write = async () => {
        throw new Error("clipboard denied");
      };
    });
    await tile.getByRole("button", { name: "复制图片" }).click();
    await expect(page.getByText("复制失败，请改用下载", { exact: true })).toBeVisible();
    await expect(tile).toHaveAttribute("aria-pressed", "false");
    const downloads = test.info().outputPath("版本下载");
    await mkdir(downloads);
    await application.evaluate(({ BrowserWindow }, directory) => {
      const session = BrowserWindow.getAllWindows()[0]!.webContents.session;
      let remaining = 9;
      const save = (_event: Electron.Event, item: Electron.DownloadItem) => {
        item.setSavePath(
          process
            .getBuiltinModule("path")
            .join(directory, process.getBuiltinModule("path").basename(item.getFilename())),
        );
        if (!--remaining) session.off("will-download", save);
      };
      session.on("will-download", save);
    }, downloads);
    await full.getByRole("button", { name: "下载全部" }).click();
    const names = outputs.map((_, index) => `样片9-${index + 1}.png`);
    await expect.poll(async () => (await readdir(downloads)).sort()).toEqual(names);
    for (const [index, name] of names.entries())
      expect(
        createHash("sha256")
          .update(await readFile(join(downloads, name)))
          .digest("hex"),
      ).toBe(assets[index % 2]!.sha256);
    await full.getByRole("button", { name: "全部添加到画布" }).click();
    await question.getByRole("button", { name: "确定", exact: true }).press("Enter");
    await expect(question).toHaveCount(0);
    await expect.poll(async () => (await copies()).length).toBe(9);
    await expect(page.getByText("已添加 9 个节点到画布", { exact: true })).toBeVisible();
    const versions = await copies();
    expect(
      versions
        .map((node) => [
          node.data.label,
          node.data.text,
          node.data.outputs?.length,
          node.data.activeOutputId,
          node.data.assetId,
        ])
        .sort(),
    ).toEqual(
      outputs.map((output, index) => [
        `样片9 · 版本${index + 1}`,
        "",
        1,
        output.id,
        output.assetId,
      ]),
    );
    await full.getByRole("button", { name: "关闭", exact: true }).click();
    await history.getByRole("button", { name: "关闭", exact: true }).click();
    await projectAction(page, "关闭项目");
    await page.getByRole("button", { name: /^版本批量回放/ }).click();
    await expect(
      page.getByRole("button", { name: "历史记录，共 9 版", exact: true }),
    ).toBeVisible();
    expect(await copies()).toEqual(versions);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("原版画布文件导入后保留主图、手动素材、提示词引用和连线", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-upstream-exchange-"));
  const paths = [32, 64].map((size) => join(process.cwd(), `resources/icons/icon-${size}.png`));
  const application = await launchCanvas(root, paths.join("\n"));
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page);
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    await expect(page.getByRole("button", { name: "将icon-64.png加入画布" })).toBeVisible();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles(
      join(process.cwd(), "tests/fixtures/upstream-reference.canvas.json"),
    );
    const image = page.locator(".react-flow__node").filter({ hasText: "上游主图" });
    const video = page.locator(".react-flow__node").filter({ hasText: "上游视频" });
    await expect(image).toBeVisible();
    await video.locator("header strong").click();
    const imageId = await image.getAttribute("data-id");
    await expect(
      page.getByRole("textbox", { name: "生成提示词" }).locator(`[data-ref="${imageId}"]`),
    ).toHaveAttribute("data-gone", "false");
    await expect
      .poll(async () => {
        const saved = await latestSnapshot(root);
        const graph = projectCanvas(saved.canvas);
        const source = graph.nodes.find((node) => node.id === imageId);
        const target = graph.nodes.find((node) => node.data.label === "上游视频");
        if (source?.type !== "creative" || target?.type !== "creative") return;
        return {
          main: saved.assets[source.data.assetId ?? ""]?.displayName,
          manual: target.data.manualReferenceIds?.map((id) => saved.assets[id]?.displayName),
          text: target.data.text,
          linked: graph.edges.some(
            (edge) => edge.source === source.id && edge.target === target.id,
          ),
        };
      })
      .toEqual({
        main: "icon-32.png",
        manual: ["icon-64.png"],
        text: `沿着 @[主图](${imageId}) 推进 #[固定镜头](motion/static_shot)`,
        linked: true,
      });
    const exported = test.info().outputPath("desktop.canvas.json");
    await application.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.once(
        "will-download",
        (_event, item) => {
          if (item.getFilename().endsWith(".canvas.json")) item.setSavePath(path);
        },
      );
    }, exported);
    await projectAction(page, "导出画布");
    await expect
      .poll(() =>
        readFile(exported, "utf8").then(
          (text) => text.length,
          () => 0,
        ),
      )
      .toBeGreaterThan(0);
    const result = JSON.parse(await readFile(exported, "utf8"));
    expect(result.format).toBe("video-canvas/canvas");
    expect(Object.keys(result.assets)).toHaveLength(2);
    expect(result.canvas.edges).toHaveLength(1);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("跨画布粘贴复制主图、手动素材和选区内的连线，目标独立重开", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-cross-paste-"));
  const paths = [32, 64].map((size) => join(process.cwd(), `resources/icons/icon-${size}.png`));
  const app = await launchCanvas(root, paths.join("\n"));
  try {
    const page = await app.firstWindow();
    const create = async (name: string) => {
      await createCanvasProject(page, name);
    };
    await create("来源");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    await expect(page.getByRole("button", { name: "将icon-64.png加入画布" })).toBeVisible();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles(
      join(process.cwd(), "tests/fixtures/upstream-reference.canvas.json"),
    );
    const nodes = page.locator(".react-flow__node"),
      edges = page.locator(".react-flow__edge");
    const image = nodes.filter({ hasText: "上游主图" });
    const video = nodes.filter({ hasText: "上游视频" });
    await expect(nodes).toHaveCount(2);
    await chooseCanvasZoom(page, "适应画布");
    await image.locator("header strong").click();
    await expect(image).toHaveClass(/\bselected\b/);
    await page.keyboard.down("ControlOrMeta");
    try {
      await video.locator("header strong").click();
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
    } finally {
      await page.keyboard.up("ControlOrMeta");
    }
    const plain = await page.evaluate(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }),
      );
      const data = new DataTransfer();
      document.body.dispatchEvent(
        new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
      );
      return data.getData("text/plain");
    });
    expect(plain).toBe("上游主图\n上游视频");
    const sourceDir = await projectDirectory(root);
    const source = await latestSnapshot(root);
    await projectAction(page, "返回项目列表");
    await create("目标");
    await expect(page.getByRole("textbox", { name: "画布名称" })).toHaveValue("目标");
    await expect(nodes).toHaveCount(0);
    const paste = () =>
      page.evaluate((text) => {
        const data = new DataTransfer();
        data.setData("text/plain", text);
        document.body.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, plain);
    await paste();
    await expect(nodes).toHaveCount(2);
    await expect(edges).toHaveCount(1);
    await paste();
    await expect(nodes).toHaveCount(4);
    await expect(edges).toHaveCount(2);
    await projectAction(page, "返回项目列表");
    await rename(sourceDir, join(root, "源工程已移走"));
    const saved = await latestSnapshot(root),
      graph = projectCanvas(saved.canvas),
      targetDir = await projectDirectory(root);
    expect(Object.keys(saved.assets)).toHaveLength(2);
    for (const asset of Object.values(saved.assets)) {
      expect(source.assets[asset.assetId]).toBeUndefined();
      expect(
        await readFile(join(targetDir, "assets", "sha256", asset.sha256.slice(0, 2), asset.sha256)),
      ).toEqual(await readFile(join(process.cwd(), "resources/icons", asset.displayName)));
    }
    for (const suffix of [" 副本", " 副本二"]) {
      const image = graph.nodes.find((node) => node.data.label === `上游主图${suffix}`),
        video = graph.nodes.find((node) => node.data.label === `上游视频${suffix}`);
      if (image?.type !== "creative" || video?.type !== "creative") throw Error("缺少目标节点");
      expect(saved.assets[image.data.assetId!]?.displayName).toBe("icon-32.png");
      expect(video.data.manualReferenceIds?.map((id) => saved.assets[id]?.displayName)).toEqual([
        "icon-64.png",
      ]);
      expect(graph.edges.some((edge) => edge.source === image.id && edge.target === video.id)).toBe(
        true,
      );
    }
    await page.getByRole("button", { name: /^目标/ }).click();
    await expect(edges).toHaveCount(2);
    await expect
      .poll(() =>
        nodes
          .filter({ hasText: "上游主图" })
          .locator("img")
          .evaluateAll(
            (images) =>
              images.filter(
                (image) => image instanceof HTMLImageElement && image.naturalWidth === 32,
              ).length,
          ),
      )
      .toBe(2);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("画布小灵快捷唤起、起步建议填入草稿并保留焦点", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-assistant-starters-"));
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page);
    await expect(page.getByRole("button", { name: "打开小灵" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+/");
    const panel = page.getByRole("region", { name: "画布小灵" });
    const input = panel.getByRole("textbox", { name: "画布消息" });
    const firstStarter = panel.getByRole("button", { name: "把选中的剧本拆成分镜" });
    await firstStarter.hover();
    await page.mouse.down();
    try {
      await expect
        .poll(() =>
          firstStarter.evaluate(
            (button) => new DOMMatrixReadOnly(getComputedStyle(button).transform).a,
          ),
        )
        .toBeCloseTo(0.985, 3);
      await expectDraft(input, "");
    } finally {
      await page.mouse.up();
    }
    await expect(input).toBeFocused();
    await expectDraft(input, "把选中的剧本拆成分镜");
    for (const starter of [
      "把选中的剧本拆成分镜",
      "整理人物，做一份资产清单",
      "把画布按场景整理整齐",
    ]) {
      await panel.getByRole("button", { name: starter }).click();
      await expectDraft(input, starter);
      await expect(input).toBeFocused();
    }
    await input.fill("保留我的修改");
    const frame = page.locator(".assistant-frame");
    await expect(frame).toHaveCSS("width", "400px");
    await expect(frame).toHaveCSS("height", "600px");
    const initial = await frame.boundingBox();
    if (!initial) throw new Error("助手浮窗未显示");
    await page.mouse.move(initial.x + 20, initial.y + 28);
    await page.mouse.down();
    await page.mouse.move(initial.x - 60, initial.y + 28);
    await page.mouse.up();
    await expect.poll(async () => (await frame.boundingBox())?.x).toBe(initial.x - 80);
    await input.focus();
    await panel.getByRole("button", { name: "停靠到右侧" }).click();
    await expect(input).toBeFocused();
    const handle = page.getByRole("separator", { name: "调整 Agent 宽度" });
    await handle.press("ArrowLeft");
    await expect(frame).toHaveCSS("width", "416px");
    await handle.dblclick();
    await expect(frame).toHaveCSS("width", "400px");
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(frame).toHaveCSS("height", "656px");
    await expect(handle).toBeHidden();
    await expectDraft(input, "保留我的修改");
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(handle).toBeVisible();
    await panel.getByRole("button", { name: "改为浮窗" }).click();
    await page.keyboard.press("ControlOrMeta+/");
    await expect(panel).toBeHidden();
    await page.keyboard.press("ControlOrMeta+/");
    await expectDraft(input, "保留我的修改");
    await panel.getByRole("button", { name: /^历史会话，当前/ }).click();
    await expect(panel.getByText("还没有会话")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel.getByText("还没有会话")).toBeHidden();
    await panel.screenshot({ path: "test-results/canvas-assistant-starters.png" });
    await panel.getByRole("button", { name: "新对话", exact: true }).click();
    await panel.getByRole("button", { name: "历史会话，当前：新对话" }).click();
    await expect(panel.getByText("还没有会话")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel.locator(".assistant-history")).toBeHidden();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const slow of [true, false])
  test(`桌宠图集${slow ? "超时后到达替换胶囊" : "解码失败后保留胶囊、不重复请求"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "link-pet-load-"));
    const application = await launchCanvas(root);
    try {
      const page = await application.firstWindow();
      await page.evaluate(() => {
        const decode = HTMLImageElement.prototype.decode;
        let count = 0;
        HTMLImageElement.prototype.decode = function () {
          if (!this.src.includes("spritesheet")) return decode.call(this);
          Reflect.set(window, "petDecodeCount", ++count);
          return new Promise<void>((resolve, reject) =>
            Reflect.set(window, "settlePet", (success: boolean) =>
              success ? decode.call(this).then(resolve, reject) : reject(Error("图集损坏")),
            ),
          );
        };
      });
      await createCanvasProject(page, "桌宠加载");
      await expect.poll(() => page.evaluate(() => Reflect.get(window, "petDecodeCount"))).toBe(1);
      const pet = page.locator(".pet-launcher"),
        fallback = page.locator(".canvas-launcher");
      await expect(pet).toHaveCount(0);
      await expect(fallback).toHaveCount(0);
      if (!slow) await page.evaluate(() => Reflect.get(window, "settlePet")(false));
      await expect(fallback).toBeVisible({ timeout: 6000 });
      await fallback.click();
      await expect(page.getByRole("button", { name: "关闭小灵" })).toBeVisible();
      await page.getByRole("button", { name: "关闭小灵" }).click();
      if (slow) {
        await page.evaluate(() => Reflect.get(window, "settlePet")(true));
        await expect(pet).toBeVisible();
        await expect(fallback).toHaveCount(0);
      }
      await projectAction(page, "关闭项目");
      await page.getByRole("button", { name: /^桌宠加载/ }).click();
      await expect(slow ? pet : fallback).toBeVisible();
      expect(await page.evaluate(() => Reflect.get(window, "petDecodeCount"))).toBe(1);
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("桌宠拖动不误开、偏好持久化、隐藏后可恢复并唤起探头", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-pet-"));
  let application = await launchCanvas(root);
  try {
    let page = await application.firstWindow();
    await createCanvasProject(page, "桌宠重启");
    let pet = page.locator(".pet-launcher");
    await expect(pet).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(pet.locator(".pet-sprite-frame")).toHaveCSS("filter", /drop-shadow/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(pet.locator(".pet-sprite-frame")).toHaveCSS("filter", "none");
    const before = await pet.boundingBox();
    if (!before) throw new Error("桌宠未就绪");
    await page.mouse.move(before.x + 40, before.y + 40);
    await page.mouse.down();
    await page.mouse.move(130, 180, { steps: 12 });
    await page.mouse.up();
    await expect(pet).toBeVisible();
    await expect.poll(async () => (await pet.boundingBox())?.x).toBeCloseTo(90, 0);
    await pet.click();
    const floating = page.locator(".assistant-frame");
    await expect.poll(async () => (await floating.boundingBox())?.x ?? 10000).toBeLessThan(240);
    await page.getByRole("button", { name: "关闭小灵" }).click();
    await pet.click({ button: "right" });
    await page.getByRole("button", { name: "安静", exact: true }).click();
    const savedLayout = () =>
      page.evaluate(async () => {
        const result = await window.desktop.settings.agentLayout({});
        if (!result.ok) throw new Error(result.code);
        return result.value;
      });
    await expect.poll(savedLayout).toMatchObject({ mode: "quiet", anchor: { corner: "tl" } });
    await application.close();
    application = await launchCanvas(root);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /^桌宠重启/ }).click();
    pet = page.locator(".pet-launcher");
    await expect.poll(async () => (await pet.boundingBox())?.x).toBeCloseTo(90, 0);
    await pet.click({ button: "right" });
    await expect(page.getByRole("button", { name: "安静", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "隐藏桌宠" }).click();
    let fallback = page.locator(".canvas-launcher");
    await expect(fallback).toBeVisible();
    await fallback.click();
    const frame = page.locator(".assistant-frame"),
      stage = await page.locator(".pet-stage").boundingBox();
    const initial = await frame.boundingBox();
    if (!initial || !stage) throw new Error("浮窗未就绪");
    const offset = { x: -130, y: 10 };
    const moved = { x: initial.x + offset.x, y: initial.y + offset.y };
    expect(initial.x + initial.width).toBe(stage.x + stage.width - 12);
    expect(initial.y + initial.height).toBe(stage.y + stage.height - 68);
    await page.mouse.move(initial.x + 20, initial.y + 28);
    await page.mouse.down();
    await page.mouse.move(moved.x + 20, moved.y + 28);
    await page.mouse.up();
    await expect.poll(savedLayout).toMatchObject({ offset });
    await page.getByRole("button", { name: "关闭小灵" }).click();
    await fallback.click();
    await expect.poll(() => frame.boundingBox()).toMatchObject(moved);
    await page.getByRole("button", { name: "停靠到右侧" }).click();
    await page.getByRole("separator", { name: "调整 Agent 宽度" }).press("ArrowLeft");
    await expect.poll(savedLayout).toMatchObject({ mode: "hidden", docked: true, width: 416 });
    await application.close();
    application = await launchCanvas(root);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /^桌宠重启/ }).click();
    fallback = page.locator(".canvas-launcher");
    pet = page.locator(".pet-launcher");
    await fallback.click();
    await expect(page.getByRole("separator", { name: "调整 Agent 宽度" })).toHaveAttribute(
      "aria-valuenow",
      "416",
    );
    await page.getByRole("button", { name: "改为浮窗" }).click();
    await expect.poll(() => page.locator(".assistant-frame").boundingBox()).toMatchObject(moved);
    await page.getByRole("button", { name: "关闭小灵" }).click();
    await fallback.click({ button: "right" });
    await page.getByRole("button", { name: "活泼", exact: true }).click();
    await projectAction(page, "关闭项目");
    await createCanvasProject(page, "桌宠第二项目");
    await expect.poll(async () => (await pet.boundingBox())?.x).toBeCloseTo(90, 0);
    await pet.click();
    const temporary = page.locator(".assistant-frame"),
      attached = await temporary.boundingBox();
    if (!attached) throw Error("未随桌宠弹出");
    await page.mouse.move(attached.x + 20, attached.y + 28);
    await page.mouse.down();
    await page.mouse.move(attached.x + 100, attached.y + 28);
    await page.mouse.up();
    await expect.poll(() => temporary.boundingBox()).toMatchObject({ x: attached.x + 80 });
    await page.getByRole("button", { name: "关闭小灵" }).click();
    await pet.click();
    await expect.poll(() => temporary.boundingBox()).toEqual(attached);
    expect((await savedLayout()).offset).toEqual(offset);
    await page.getByRole("button", { name: "关闭小灵" }).click();
    await pet.click({ button: "right" });
    await page.getByRole("button", { name: "回到右下角" }).click();
    await expect.poll(async () => (await pet.boundingBox())?.x).toBeCloseTo(before.x, 0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(pet.locator(".pet-sprite")).toHaveCSS("animation-name", "none");
    await expect(pet.locator(".pet-sprite")).toHaveAttribute("data-row", "9");
    await pet.screenshot({ path: "test-results/pet-sleeping.png" });
    await pet.click();
    await expect(pet).toBeHidden();
    await expect(page.locator(".pet-peek .pet-sprite")).toBeVisible();
    await page.getByRole("button", { name: "关闭小灵" }).click();
    await expect(pet).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("小灵粘贴与拖入图片、发送三份剧本并在重启后查看全文", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-agent-images-"));
  let receivedImages = 0;
  let receivedDocument = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    for (const message of payload.messages ?? []) {
      if (message.role === "user" && Array.isArray(message.content))
        receivedImages = Math.max(
          receivedImages,
          message.content.filter(
            (part: { type: string; image_url?: { url: string } }) =>
              part.type === "image_url" && part.image_url?.url.startsWith("data:image/png;base64,"),
          ).length,
        );
      if (
        payload.model === "text" &&
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("<附件文件")
      )
        receivedDocument = message.content;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "附件已查收" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing model fixture");
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      if (!list.ok) throw new Error(list.code);
      const plugin = list.value.plugins.find((entry) => entry.key === "openai");
      if (!plugin) throw new Error("Missing OpenAI plugin");
      for (const vision of [false, true]) {
        const result = await settings.save({
          expectedRevision: 0,
          pluginHash: plugin.hash,
          approve: true,
          secret: "fixture-secret",
          fields: {
            label: vision ? "看图模型" : "文本模型",
            endpoint,
            model: vision ? "vision" : "text",
            allowLocal: true,
            agentEnabled: true,
            agentVision: vision,
            channel: { api: "chat_completions" },
          },
        });
        if (!result.ok) throw new Error(result.code);
      }
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page, "附件验收");
    await page.getByRole("button", { name: "打开小灵" }).click();
    const editor = page.getByRole("textbox", { name: "画布消息" });
    const tray = page.getByRole("region", { name: "图片附件" });
    const model = page.getByRole("button", { name: "Agent 模型" });
    await chooseAssistantModel(model, { name: "text" });
    await editor.fill("请对照图片");
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.fillStyle = "#c7ac73";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL();
    });
    const initial = await latestSnapshot(root);
    await editor.evaluate((element, data) => {
      const bytes = Uint8Array.from(atob(data.split(",")[1] ?? ""), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "粘贴.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    }, png);
    await expect(tray.locator('[data-status="done"]')).toHaveCount(1);
    await editor.evaluate((element, data) => {
      const bytes = Uint8Array.from(atob(data.split(",")[1] ?? ""), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      for (let index = 1; index <= 9; index++)
        transfer.items.add(new File([bytes], `拖入-${index}.png`, { type: "image/png" }));
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    }, png);
    await expect(tray.locator('[data-status="done"]')).toHaveCount(9);
    await expectDraft(editor, "请对照图片");
    await expect(page.getByText("一条消息最多 9 张，多出的 1 张没加")).toBeVisible();
    await expect(tray.getByText("当前模型看不到图片，换一个能看图的模型或移除图片")).toBeVisible();
    const saved = await latestSnapshot(root);
    expect(projectCanvas(saved.canvas).nodes).toEqual(projectCanvas(initial.canvas).nodes);
    expect(Object.keys(saved.assets)).toHaveLength(9);
    await tray.getByRole("button", { name: "移除 拖入-1.png" }).click();
    await expect(tray.locator('[data-status="done"]')).toHaveCount(8);
    await page.getByRole("button", { name: "添加附件" }).click();
    const picker = page.getByLabel("上传图片");
    const largePng = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      const noise = context.createImageData(canvas.width, canvas.height);
      for (let offset = 0; offset < noise.data.length; offset += 65536)
        crypto.getRandomValues(noise.data.subarray(offset, offset + 65536));
      context.putImageData(noise, 0, 0);
      return canvas.toDataURL();
    });
    const largeBytes = Buffer.from(largePng.split(",")[1] ?? "", "base64");
    expect(largeBytes.length).toBeGreaterThan(384 * 1024);
    await picker.setInputFiles({
      name: "上传.png",
      mimeType: "image/png",
      buffer: largeBytes,
    });
    await page.keyboard.press("Escape");
    await expect(tray.locator('[data-status="done"]')).toHaveCount(9);
    await chooseAssistantModel(model, { name: "vision" });
    await editor.press("Enter");
    await expect.poll(() => receivedImages, { timeout: 15000 }).toBe(9);
    await expect(tray).toHaveCount(0);
    const thumbs = page.getByRole("button", { name: /^查看大图：/ });
    await expect(thumbs).toHaveCount(9);
    await expect(thumbs.first()).toHaveCSS("width", "48px");
    await thumbs.first().click();
    const gallery = page.getByRole("dialog", { name: "媒体预览" });
    await expect(gallery.getByText("本条消息 1 / 9")).toBeVisible();
    await expect(gallery.getByRole("button", { name: "上一个" })).toBeDisabled();
    await page.keyboard.press("ArrowRight");
    await expect(gallery.getByText("本条消息 2 / 9")).toBeVisible();
    await gallery.getByRole("button", { name: "上传.png" }).click();
    await expect(gallery.getByText("本条消息 9 / 9")).toBeVisible();
    await expect(gallery.getByRole("button", { name: "下一个" })).toBeDisabled();
    await expect(gallery.getByText("640×480")).toBeVisible();
    await expect
      .poll(() =>
        gallery.locator(".gallery-stage img").evaluate((image) => {
          const stage = image.parentElement?.getBoundingClientRect();
          return stage
            ? Math.abs(
                image.getBoundingClientRect().width - Math.min(stage.width, (stage.height * 4) / 3),
              )
            : Infinity;
        }),
      )
      .toBeLessThan(1);
    await gallery.screenshot({ path: "test-results/assistant-history-gallery.png" });
    const exported = join(root, "gallery-original.png");
    await application.evaluate(({ dialog }, path) => {
      let cancel = true;
      dialog.showSaveDialog = (async () => {
        if (cancel) {
          cancel = false;
          return { canceled: true, filePath: "" };
        }
        return { canceled: false, filePath: path };
      }) as typeof dialog.showSaveDialog;
    }, exported);
    await gallery.getByRole("button", { name: "下载原文件" }).click();
    await expect(gallery.getByRole("status")).toHaveText("已取消保存");
    await gallery.getByRole("button", { name: "下载原文件" }).click();
    await expect(gallery.getByRole("status")).toHaveText("已保存原文件");
    expect((await readFile(exported)).equals(largeBytes)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(gallery).toHaveCount(0);
    await expect(thumbs.first()).toBeFocused();
    await page.getByRole("button", { name: "新对话", exact: true }).click();
    await chooseAssistantModel(model, { name: "text" });
    await page.getByRole("button", { name: "添加附件" }).click();
    const documentPicker = page.getByLabel("上传故事或剧本");
    const scriptBody = "# 第一场\n小灵读取这份剧本。\n" + "镜".repeat(60000) + "原文收尾";
    await documentPicker.setInputFiles([
      {
        name: "验收剧本.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(scriptBody),
      },
      ...["对白.txt", "场景.markdown", "第四份.txt"].map((name) => ({
        name,
        mimeType: "text/plain",
        buffer: Buffer.from(name + "正文"),
      })),
    ]);
    await expect(page.getByText("一条消息最多 3 个文档")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "文档附件" })).toBeVisible();
    await expect(page.getByText("验收剧本.md", { exact: true })).toBeVisible();
    await editor.fill("请读取附件");
    await editor.press("Enter");
    await expect.poll(() => receivedDocument, { timeout: 15000 }).toContain("小灵读取这份剧本。");
    expect(receivedDocument).toContain("只带入了前 60000 个字");
    expect(receivedDocument).not.toContain("原文收尾");
    expect(receivedDocument).toContain("对白.txt正文");
    expect(receivedDocument).toContain("场景.markdown正文");
    await expect(page.getByRole("region", { name: "文档附件" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开文件：验收剧本.md" })).toBeVisible();
    await chooseAssistantModel(model, { name: "vision" });
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^附件验收/ }).click();
    await reopened.getByRole("button", { name: "打开小灵" }).click();
    await expect(reopened.getByRole("button", { name: "Agent 模型" })).toHaveText("vision");
    await reopened.getByRole("button", { name: "打开文件：验收剧本.md" }).click();
    await expect(reopened.getByRole("dialog", { name: "验收剧本.md" }).locator("pre")).toHaveText(
      scriptBody,
    );
    await reopened.keyboard.press("Escape");
  } finally {
    server.closeAllConnections();
    server.close();
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("小灵会话改名与确认删除跨重启保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-assistant-history-"));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const content = payload.tools?.length ? "已记录" : "分镜记录";
    if (payload.stream)
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
    else
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        }),
      );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("缺少会话测试端口");
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      const plugin = list.ok && list.value.plugins.find((entry) => entry.key === "openai");
      if (!plugin) throw Error("无测试适配器");
      const saved = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture",
        fields: {
          label: "会话验收",
          model: "history",
          endpoint,
          allowLocal: true,
          agentEnabled: true,
          channel: { api: "chat_completions" },
        },
      });
      if (!saved.ok) throw Error(saved.code);
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page, "历史验收");
    await page.getByRole("button", { name: "打开小灵" }).click();
    const history = page.getByRole("button", { name: /^历史会话，当前/ });
    const input = page.getByRole("textbox", { name: "会话标题" });
    const create = page.getByRole("button", { name: "新对话", exact: true });
    await create.click();
    await expect(history).toHaveAccessibleName("历史会话，当前：新对话");
    const send = async (message: string) => {
      await page.getByRole("textbox", { name: "画布消息" }).fill(message);
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.getByRole("log").getByText("已记录", { exact: true })).toBeVisible();
      await expect(create).toBeEnabled();
    };
    await send("保留分镜");
    const original = await history.getAttribute("aria-label");
    await history.dblclick();
    await input.pressSequentially("discard");
    await expect(input).toHaveValue("discard");
    await input.press("Escape");
    await expect(history).toHaveAccessibleName(original!);
    await history.dblclick();
    await input.pressSequentially("Storyboard");
    await input.press("Tab");
    await expect(history).toHaveAccessibleName("历史会话，当前：Storyboard");
    await history.dblclick();
    await input.fill("保留分镜方案");
    await input.press("Enter");
    await expect(history).toHaveAccessibleName("历史会话，当前：保留分镜方案");
    await create.click();
    await expect(history).toHaveAccessibleName("历史会话，当前：新对话");
    await send("删除草案");
    await history.dblclick();
    await input.fill("删除草案");
    await input.press("Enter");
    await expect(history).toHaveAccessibleName("历史会话，当前：删除草案");
    await history.click();
    const remove = page.getByRole("button", { name: "删除「删除草案」", exact: true });
    const triggerBox = (await history.boundingBox())!;
    const menuBox = (await page.locator(".assistant-history:popover-open").boundingBox())!;
    expect(menuBox.y).toBeCloseTo(triggerBox.y + triggerBox.height + 4, 0);
    expect(menuBox.x).toBeGreaterThanOrEqual(5);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
      await page.evaluate(() => innerWidth - 5),
    );
    await remove.click();
    await page.keyboard.press("Escape");
    await history.click();
    await remove.click();
    await page.getByRole("button", { name: "确认删除「删除草案」" }).click();
    await expect(history).toHaveAccessibleName("历史会话，当前：保留分镜方案");
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^历史验收/ }).click();
    await reopened.getByRole("button", { name: "打开小灵" }).click();
    await reopened.getByRole("button", { name: "历史会话，当前：保留分镜方案" }).click();
    await expect(reopened.locator(".assistant-history-row")).toHaveCount(1);
  } finally {
    server.closeAllConnections();
    server.close();
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("图片节点内单选上传：错型不动图，确认即断入线，撤销或失败重试不换节点", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-fill-node-"));
  const app = await launchCanvas(root);
  try {
    const page = await app.firstWindow(),
      bad = join(root, "修复.png"),
      wrong = join(root, "声音.wav");
    const png = await readFile(join(process.cwd(), "resources/icons/icon-32.png"));
    await Promise.all([writeFile(bad, "bad image"), writeFile(wrong, "not an image")]);
    await createCanvasProject(page);
    await page.getByRole("button", { name: /^文本 脚本、分镜描述/ }).click();
    await page
      .locator(".react-flow__handle-right")
      .dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 250, y: 190 } });
    await page.getByRole("menuitem", { name: "图片生成", exact: true }).click();
    const edges = page.locator(".react-flow__edge");
    await expect(edges).toHaveCount(1);
    const id = await page.locator(".react-flow__node.selected").getAttribute("data-id");
    const card = page.locator(`[data-id="${id}"]`),
      pick = async (path: string) => {
        const pending = page.waitForEvent("filechooser");
        await card.getByRole("button", { name: "导入素材到节点" }).click();
        const chooser = await pending;
        expect(chooser.isMultiple()).toBe(false);
        expect(await chooser.element().getAttribute("accept")).toBe("image/*");
        await chooser.setFiles(path);
      };
    const graph = async () => projectCanvas((await latestSnapshot(root)).canvas);
    await expect.poll(async () => (await graph()).edges.length).toBe(1);
    const initial = (await graph()).nodes.find((node) => node.id === id)!;
    await pick(wrong);
    await expect(page.getByRole("alert").filter({ hasText: "这个节点只收图片" })).toBeVisible();
    await expect(edges).toHaveCount(1);
    await holdCanvasFile(app, "sync");
    await pick(bad);
    await expect(card.getByRole("status")).toContainText("处理中");
    await expect(edges).toHaveCount(0);
    await expect(page.getByRole("region", { name: "生成确认" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "关闭项目文件" })).toBeHidden();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(edges).toHaveCount(1);
    await releaseCanvasFile(app);
    await expect(card.getByRole("button", { name: "导入素材到节点" })).toBeVisible();
    await expect
      .poll(async () => (await graph()).nodes.find((node) => node.id === id))
      .toEqual(initial);
    await pick(bad);
    await expect(card.getByRole("button", { name: "重试" })).toBeVisible();
    await expect(edges).toHaveCount(0);
    await writeFile(bad, png);
    await card.getByRole("button", { name: "重试" }).click();
    await expect(card.locator('img[alt="修复.png"]')).toBeVisible();
    await expect
      .poll(async () => (await graph()).nodes.find((node) => node.id === id))
      .toMatchObject({
        id,
        position: initial.position,
        data: { label: initial.data.label, uploaded: true, assetId: expect.any(String) },
      });
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(edges).toHaveCount(1);
    await expect
      .poll(async () => (await graph()).nodes.find((node) => node.id === id))
      .toEqual(initial);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(edges).toHaveCount(0);
    await expect(card.locator('img[alt="修复.png"]')).toBeVisible();
  } finally {
    await releaseCanvasFile(app).catch(() => {});
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("在画布拖入磁盘文件时填充空节点并保留已有图片", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-drop-files-"));
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page);
    await addCanvasNode(page, "图片生成");
    const original = page.locator(".react-flow__node").first();
    const id = await original.getAttribute("data-id");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "disk-drop-fixture";
      input.hidden = true;
      document.body.append(input);
    });
    for (const color of ["red", "blue"]) {
      const filename = join(root, `${color}.png`);
      const png = await page.evaluate((color) => {
        const canvas = document.createElement("canvas");
        canvas.width = 10;
        canvas.height = 7;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("缺少画布");
        context.fillStyle = color;
        context.fillRect(0, 0, 10, 7);
        return canvas.toDataURL().split(",")[1] ?? "";
      }, color);
      await writeFile(filename, Buffer.from(png, "base64"));
      await page.locator("#disk-drop-fixture").setInputFiles(filename);
      const transfer = await page.evaluateHandle(() => {
        const file = document.querySelector<HTMLInputElement>("#disk-drop-fixture")?.files?.[0];
        if (!file) throw new Error("缺少磁盘文件");
        const transfer = new DataTransfer();
        transfer.items.add(file);
        return transfer;
      });
      const media = original.locator(".node-media");
      await media.dispatchEvent("dragover", { dataTransfer: transfer });
      await expect(page.locator(".canvas-file-over")).toBeVisible();
      await media.dispatchEvent("drop", { dataTransfer: transfer, clientX: 500, clientY: 400 });
      await transfer.dispose();
      await expect(page.locator(".canvas-file-over")).toHaveCount(0);
      await expect(page.locator(`.react-flow__node img[alt="${color}.png"]`)).toHaveCount(1);
    }
    await expect
      .poll(
        async () =>
          projectCanvas((await latestSnapshot(root)).canvas).nodes.filter(
            (node) => node.type === "creative" && node.data.uploaded,
          ).length,
      )
      .toBe(2);
    await expect(original).toHaveAttribute("data-id", id ?? "");
    await expect(original.locator("img")).toHaveAttribute("alt", "red.png");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("画布剪贴板区分富文本、节点和图片，粘贴结果重开可用", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-paste-e2e-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "粘贴验收");
    await expect(page.getByRole("button", { name: "打开小灵" })).toBeVisible();
    const paste = (mode: "rich" | "file" | "same" | "empty" | "long") =>
      page.evaluate(async (mode) => {
        const data = new DataTransfer();
        if (mode === "rich" || mode === "file") {
          const canvas = document.createElement("canvas");
          canvas.width = 8;
          canvas.height = 5;
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
          if (!blob) throw new Error("无法生成测试图");
          data.items.add(new File([blob], "image.png", { type: "image/png" }));
        }
        if (mode === "rich") data.setData("text/html", "<p>剪贴板文字</p>");
        if (mode !== "empty")
          data.setData("text/plain", mode === "long" ? "🌅".repeat(20001) : " 剪贴板\r\n文字 ");
        document.body.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, mode);
    await paste("rich");
    await expect(page.getByRole("region", { name: "文本内容", exact: true })).toHaveText(
      " 剪贴板\n文字 ",
    );
    await expect(page.locator(".react-flow__node img")).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const data = new DataTransfer();
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "c",
            code: "KeyC",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        document.body.dispatchEvent(
          new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
        );
        return data.getData("text/plain");
      }),
    ).toBe(" 剪贴板\n文字 ");
    await paste("same");
    await paste("empty");
    await expect(page.getByRole("region", { name: "文本 副本二内容", exact: true })).toHaveText(
      " 剪贴板\n文字 ",
    );
    await paste("file");
    await expect(page.locator('.react-flow__node img[alt="粘贴图片.png"]')).toHaveCount(1);
    await paste("long");
    await expect(
      page.getByRole("alert").filter({ hasText: "文字太长，只放进了前 20000 个字" }),
    ).toBeVisible();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.nodes.length).toBe(5);
    const nodes = projectCanvas((await latestSnapshot(root)).canvas).nodes;
    const source = nodes.find((node) => node.data.label === "文本");
    if (!source) throw new Error("缺少源文本");
    for (const [index, label] of ["文本 副本", "文本 副本二"].entries()) {
      expect(nodes.find((node) => node.data.label === label)?.position).toEqual({
        x: source.position.x + 48 * (index + 1),
        y: source.position.y + 48 * (index + 1),
      });
    }
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^粘贴验收/ }).click();
    await expect(reopened.locator('.react-flow__node img[alt="粘贴图片.png"]')).toHaveCount(1);
    await expect(reopened.getByRole("region", { name: "文本 2内容", exact: true })).toHaveText(
      "🌅".repeat(20000),
    );
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("剪贴板混合媒体不需要路径：20MiB截图、MP4、WAV按三列落位，超限跳过并保留实际字节", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-paste-media-"));
  let app = await launchCanvas(root);
  try {
    const page = await app.firstWindow(),
      video = join(root, "片段.mp4");
    const ffmpeg = join(
      process.cwd(),
      "out/media",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    const encode =
      process.platform === "darwin"
        ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
        : ["-c:v", "libx264"];
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=green:s=64x32",
      "-frames:v",
      "2",
      ...encode,
      video,
    ]);
    const image = await readFile(join(process.cwd(), "resources/icons/icon-32.png")),
      movie = await readFile(video);
    const pad = Buffer.alloc(20 * 1024 * 1024 - image.length);
    pad.writeUInt32BE(pad.length - 12);
    pad.write("paDd", 4);
    pad.writeUInt32BE(crc32(pad.subarray(4, -4)), pad.length - 4);
    const png = Buffer.concat([image.subarray(0, -12), pad, image.subarray(-12)]);
    const wav = Buffer.concat([
      Buffer.from(
        "52494646a43e000057415645666d74201000000001000100401f0000803e00000200100064617461803e0000",
        "hex",
      ),
      Buffer.alloc(16000),
    ]);
    await createCanvasProject(page, "剪贴板媒体");
    await expect(page.getByRole("button", { name: "打开小灵" })).toBeVisible();
    await page.evaluate(
      ({ image, padLength, checksum, video, audio }) => {
        const bytes = (base64: string) =>
          Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const padding = new Uint8Array(padLength),
          view = new DataView(padding.buffer);
        view.setUint32(0, padLength - 12);
        padding.set(new TextEncoder().encode("paDd"), 4);
        view.setUint32(padLength - 4, checksum);
        const raw = bytes(image),
          data = new DataTransfer();
        data.items.add(
          new File([raw.slice(0, -12), padding, raw.slice(-12)], "image.png", {
            type: "image/png",
          }),
        );
        data.items.add(
          new File([new Uint8Array(20 * 1024 * 1024 + 1)], "过大.png", { type: "image/png" }),
        );
        data.items.add(new File([bytes(video)], "片段.mp4", { type: "video/mp4" }));
        data.items.add(new File([bytes(audio)], "声音.wav", { type: "audio/wav" }));
        data.items.add(new File([raw], "封面.png", { type: "image/png" }));
        data.setData("text/plain", "不应建成文本");
        document.body.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      },
      {
        image: image.toString("base64"),
        padLength: pad.length,
        checksum: pad.readUInt32BE(pad.length - 4),
        video: movie.toString("base64"),
        audio: wav.toString("base64"),
      },
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(
      page.getByRole("alert").filter({ hasText: "文件超过 20MB，换个小点的" }),
    ).toBeVisible();
    const stored = async () => {
      const state = await latestSnapshot(root);
      return projectCanvas(state.canvas).nodes.flatMap((node) =>
        node.type === "creative" && node.data.assetId
          ? [{ node, asset: state.assets[node.data.assetId]! }]
          : [],
      );
    };
    await expect.poll(stored).toHaveLength(4);
    const saved = await stored();
    const origin = saved.find((entry) => entry.node.data.label === "粘贴图片")!.node.position;
    for (const [index, [name, kind, content]] of (
      [
        ["粘贴图片.png", "image", png],
        ["片段.mp4", "video", movie],
        ["声音.wav", "audio", wav],
        ["封面.png", "image", image],
      ] as const
    ).entries()) {
      const record = saved.find((entry) => entry.asset.displayName === name)!;
      expect(record.node.data.kind).toBe(kind);
      expect(record.node.position).toEqual({
        x: origin.x + 440 * (index % 3),
        y: origin.y + 380 * Math.floor(index / 3),
      });
      expect(record.asset).toMatchObject({
        storage: { kind: "blob" },
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: content.length,
      });
    }
    await app.close();
    app = await launchCanvas(root);
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: /^剪贴板媒体/ }).click();
    await expect(reopened.locator(".react-flow__node")).toHaveCount(4);
    expect(await stored()).toEqual(saved);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("剪贴板分块失败可用同一个File重试，中途删除释放文件且不登记半成品", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-paste-retry-")),
    app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page);
    await expect(page.getByRole("button", { name: "打开小灵" })).toBeVisible();
    await app.evaluate(() => {
      const fs = process.getBuiltinModule("fs/promises"),
        modules = process.getBuiltinModule("module"),
        open = fs.open;
      fs.open = async (...args) => {
        const handle = await open(...args);
        if (typeof args[0] === "string" && args[0].endsWith(".clip")) {
          fs.open = open;
          modules.syncBuiltinESMExports();
          handle.write = new Proxy(handle.write, {
            apply() {
              throw Error("test: clipboard write failed");
            },
          });
        }
        return handle;
      };
      modules.syncBuiltinESMExports();
    });
    const paste = (name: string) =>
      page.evaluate(async (name) => {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 5;
        const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done));
        if (!blob) throw Error("没有图像");
        const data = new DataTransfer();
        data.items.add(new File([blob], name, { type: "image/png" }));
        document.body.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, name);
    await paste("保留.png");
    const card = page.locator(".react-flow__node").first();
    await expect(card.getByRole("button", { name: "重试" })).toBeVisible();
    const id = await card.getAttribute("data-id");
    expect(Object.keys((await latestSnapshot(root)).assets)).toHaveLength(0);
    await card.getByRole("button", { name: "重试" }).click();
    await expect(card.locator('img[alt="保留.png"]')).toHaveCount(1);
    await expect(card).toHaveAttribute("data-id", id!);
    await holdCanvasFile(app, "sync");
    await paste("删除.png");
    const pending = page
      .locator(".react-flow__node")
      .filter({ has: page.getByRole("status").filter({ hasText: "处理中" }) });
    await expect(pending).toHaveCount(1);
    await pending.focus();
    await page.keyboard.press("Backspace");
    await expect(pending).toHaveCount(0);
    await releaseCanvasFile(app);
    await expect.poll(async () => readdir(join(await projectDirectory(root), "tmp"))).toEqual([]);
    expect(Object.keys((await latestSnapshot(root)).assets)).toHaveLength(1);
  } finally {
    await releaseCanvasFile(app).catch(() => {});
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("先选图片画幅读取较慢时，第二个文件先入库，图片仍落在第一列并被选中", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-paste-aspect-"));
  const app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page);
    await expect(page.getByRole("button", { name: "打开小灵" })).toBeVisible();
    const audio = Buffer.concat([
      Buffer.from(
        "52494646a43e000057415645666d74201000000001000100401f0000803e00000200100064617461803e0000",
        "hex",
      ),
      Buffer.alloc(16000),
    ]);
    await page.evaluate(async (audio) => {
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 8;
      const image = await new Promise<Blob | null>((done) => canvas.toBlob(done));
      if (!image) throw Error("无法生成图片");
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        ...descriptor,
        set(url: string) {
          if (!url.startsWith("blob:")) return descriptor.set!.call(this, url);
          Object.defineProperty(HTMLImageElement.prototype, "src", descriptor);
          Object.assign(window, { releasePasteImage: () => descriptor.set!.call(this, url) });
        },
      });
      const transfer = new DataTransfer();
      transfer.items.add(new File([image], "慢图.png", { type: "image/png" }));
      transfer.items.add(
        new File([Uint8Array.from(atob(audio), (char) => char.charCodeAt(0))], "先到.wav", {
          type: "audio/wav",
        }),
      );
      document.body.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    }, audio.toString("base64"));
    const nodes = page.locator(".react-flow__node");
    await expect(nodes).toHaveCount(1);
    await expect(nodes.locator("header strong")).toHaveText("先到");
    await expect
      .poll(async () =>
        Object.values((await latestSnapshot(root)).assets).map((asset) => asset.displayName),
      )
      .toEqual(["先到.wav"]);
    await expect(nodes).toHaveCount(1);
    await page.evaluate(() =>
      (window as unknown as { releasePasteImage: () => void }).releasePasteImage(),
    );
    await expect(page.locator(".react-flow__node.selected header strong")).toHaveText("慢图");
    await expect
      .poll(async () => {
        const saved = projectCanvas((await latestSnapshot(root)).canvas).nodes;
        const image = saved.find((node) => node.data.label === "慢图"),
          audio = saved.find((node) => node.data.label === "先到");
        return image?.type === "creative" && audio
          ? [
              audio.position.x - image.position.x,
              audio.position.y - image.position.y,
              image.data.mediaAspect,
            ]
          : [];
      })
      .toEqual([440, 0, 0.5]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("剪贴板传输回执只接受当前项目连续分块，不能当作外部引用或未完成文件使用", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-clip-scope-")),
    app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    const actual = await page.evaluate(async () => {
      const { projects, dialogs } = window.desktop,
        parent = await dialogs.selectProjectParent();
      if (!parent.ok || parent.value.cancelled) throw Error("没有目录");
      const created = await projects.create({
        name: "分块授权",
        directoryToken: parent.value.directoryToken,
        operationId: crypto.randomUUID(),
      });
      if (!created.ok) throw Error("没有项目");
      const { projectHandle, revision } = created.value,
        base = { projectHandle, name: "测试.png", kind: "image" as const, size: 3 };
      const begin = await projects.beginClipboardFile(base);
      if (!begin.ok) throw Error("没有文件授权");
      const handle = { projectHandle, fileToken: begin.value.fileToken },
        start = {
          ...handle,
          expectedRevision: revision,
          operationId: crypto.randomUUID(),
          forCanvasUpload: true,
        };
      const append = (offset: number, length: number) =>
        projects.appendClipboardFile({ ...handle, offset, bytes: new Uint8Array(length) });
      const first = await append(0, 1);
      const denied: Array<{ ok: boolean }> = [
        await projects.beginClipboardFile({ ...base, size: 20 * 1024 * 1024 + 1 }),
        await projects.beginClipboardFile({ ...base, name: "../错.png" }),
        await append(1, 1024 * 1024 + 1),
        await append(0, 1),
        await append(2, 1),
        await append(1, 3),
        await projects.appendClipboardFile({
          ...handle,
          projectHandle: crypto.randomUUID(),
          offset: 1,
          bytes: new Uint8Array(2),
        }),
        await projects.startImport(start),
      ];
      const second = await append(1, 2);
      denied.push(
        await projects.startImport({ ...start, importMode: "reference" }),
        await projects.startImport({ ...start, forCanvasUpload: false }),
        await projects.importAsset({
          projectHandle,
          fileToken: handle.fileToken,
          expectedRevision: revision,
          operationId: crypto.randomUUID(),
        }),
      );
      await projects.discardMedia(handle);
      denied.push(await append(3, 1), await projects.startImport(start));
      return {
        first: first.ok && first.value.received,
        second: second.ok && second.value.received,
        accepted: denied.filter((result) => result.ok).length,
      };
    });
    expect(actual).toEqual({ first: 1, second: 3, accepted: 0 });
    expect(Object.keys((await latestSnapshot(root)).assets)).toHaveLength(0);
    expect(await readdir(join(await projectDirectory(root), "tmp"))).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("文本生成中卡片锁定，无历史时隐藏工具栏，下游引用随正文更新", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "link-text-running-"));
  let finish: (() => void) | undefined;
  const prompts: string[] = [];
  const png = (await readFile("resources/icons/icon-32.png")).toString("base64");
  const server = createServer((request, response) => {
    if (request.url === "/v1/images/generations") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        prompts.push(JSON.parse(Buffer.concat(chunks).toString()).prompt);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: [{ b64_json: png }] }));
      });
      return;
    }
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    finish = () => {
      if (!response.writableEnded)
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ choices: [{ message: { content: "回填对白" } }] }));
    };
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("本地回放服务未启动");
  const app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      const plugin = list.ok && list.value.plugins.find((entry) => entry.key === "openai");
      if (!plugin) throw Error("缺少文本适配器");
      const result = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-key",
        fields: {
          label: "文本回放",
          endpoint,
          model: "fixture",
          allowLocal: true,
          agentEnabled: false,
          channel: { api: "chat_completions" },
        },
      });
      if (!result.ok) throw Error(result.code);
      const image = list.ok && list.value.plugins.find((entry) => entry.key === "openai-image");
      if (!image) throw Error("缺少图片适配器");
      const model = await settings.save({
        expectedRevision: 0,
        pluginHash: image.hash,
        approve: true,
        secret: "fixture-key",
        fields: {
          label: "图片回放",
          endpoint,
          model: "gpt-image-1",
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!model.ok) throw Error(model.code);
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page);
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    const fixture = {
      format: "video-canvas/canvas",
      version: 1,
      assets: {},
      canvas: {
        title: "运行中引用",
        nodes: [
          {
            id: "source",
            type: "canvas",
            position: { x: 30, y: 155 },
            data: { kind: "script", label: "对白", text: "原来的对白" },
          },
          {
            id: "image",
            type: "canvas",
            position: { x: 900, y: 155 },
            data: { kind: "image", label: "站台", params: { prompt: "特写" } },
          },
        ],
        edges: [{ id: "ref", source: "source", target: "image" }],
      },
    };
    await (await chooser).setFiles({
      name: "linked.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    const body = page.locator(".canvas-text-preview");
    const image = page.locator("article[data-card-kind=image]");
    const sendImage = async (expected: string[]) => {
      await image.click({ position: { x: 32, y: 32 } });
      const start = page.getByRole("button", { name: "开始生成", exact: true });
      await start.click();
      await expect.poll(() => prompts).toEqual(expected);
      await expect(start).toBeEnabled();
    };
    const before = "特写\n\n原来的对白";
    await sendImage([before]);
    await body.click();
    await projectAction(page, "所选节点属性");
    await page.getByRole("button", { name: "生成内容", exact: true }).click();
    await page.getByRole("button", { name: "确认生成", exact: true }).click();
    await expect.poll(() => Boolean(finish)).toBe(true);
    await expect(body).toHaveText("生成中…");
    await body.dblclick();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "放大预览" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "复制文本" })).toHaveCount(0);
    await chooseCanvasZoom(page, "适应画布");
    await image.click({ position: { x: 32, y: 32 } });
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect
      .poll(
        async () =>
          Object.values((await latestSnapshot(root)).jobs).filter((entry) => {
            const job = entry as { kind?: string; status?: string; input?: { prompt?: string } };
            return job.kind === "image" && job.status === "queued" && job.input?.prompt === "特写";
          }).length,
      )
      .toBe(1);
    const edge = page.locator(".react-flow__edge");
    const point = await page.waitForFunction(() => {
      const path = document.querySelector<SVGPathElement>(".react-flow__edge-path");
      const matrix = path?.getScreenCTM();
      if (!path || !matrix) return false;
      for (const ratio of [0.37, 0.63, 0.28, 0.72]) {
        const { x, y } = path
          .getPointAtLength(path.getTotalLength() * ratio)
          .matrixTransform(matrix);
        if (document.elementFromPoint(x, y)?.closest(".react-flow__edge")) return { x, y };
      }
      return false;
    });
    const hit = await point.jsonValue();
    if (!hit) throw new Error("缺少可操作的连线区域");
    await page.mouse.click(hit.x, hit.y);
    const scissors = page.getByRole("button", { name: "断开连接", exact: true });
    await expect(edge).toHaveClass(/selected/);
    await expect(scissors).toBeVisible();
    const anchor = () =>
      scissors.evaluate((button) => getComputedStyle(button.parentElement!).offsetDistance);
    const clickedRatio = await anchor();
    expect(clickedRatio).not.toBe("50%");
    finish!();
    await expect(body).toHaveText("回填对白");
    await expect.poll(() => prompts).toEqual([before, "特写"]);
    await expect(edge).toHaveClass(/selected/);
    await expect(scissors).toBeVisible();
    expect(await anchor()).toBe(clickedRatio);
    await sendImage([before, "特写", "特写\n\n回填对白"]);
    await body.dblclick();
    const editor = page.getByRole("textbox", { name: "文本内容" });
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(editor).toHaveText("回填对白");
    await mkdir(test.info().outputDir, { recursive: true });
    await writeFile(test.info().outputPath("linked-text-prompts.json"), JSON.stringify(prompts));
  } finally {
    finish?.();
    server.close();
    server.closeAllConnections();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("原版文本失败卡编辑后恢复正文，撤销和重开恢复失败原因", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-failed-text-"));
  let app = await launchCanvas(root);
  try {
    let page = await app.firstWindow();
    await createCanvasProject(page, "剧本恢复");
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    const reason = "服务暂时不可用";
    const node = {
      id: "script",
      type: "canvas",
      position: { x: 200, y: 180 },
      data: { kind: "script", label: "对白", text: "旧稿", status: "error", error: reason },
    };
    await (await chooser).setFiles({
      name: "failed.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "video-canvas/canvas",
          version: 1,
          assets: {},
          canvas: { title: "剧本恢复", nodes: [node], edges: [] },
        }),
      ),
    });
    const saved = async () => projectCanvas((await latestSnapshot(root)).canvas).nodes[0]?.data;
    await page.locator(".react-flow__node").getByRole("alert").dblclick();
    const editor = page.getByRole("textbox", { name: "文本内容" });
    await expect(editor).toHaveText("旧稿");
    await editor.click();
    await editor.press("ControlOrMeta+a");
    await page.keyboard.insertText("新稿");
    await editor.press("Escape");
    await expect.poll(saved).toMatchObject({ text: "新稿", textStatus: "done" });
    expect(await saved()).not.toHaveProperty("textError");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect
      .poll(saved)
      .toMatchObject({ text: "旧稿", textStatus: "error", textError: reason });
    await app.close();
    app = await launchCanvas(root);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /^剧本恢复/ }).click();
    await expect(page.getByRole("button", { name: "失败节点 1 个" })).toBeVisible();
    await expect(page.locator(".react-flow__node").getByRole("alert")).toHaveText(reason);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("文本节点预览链接支持点击和回车，保留当前画布", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-text-anchor-"));
  const app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page, "剧本链接");
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    const url = "https://example.invalid/plan?shot=2";
    const fixture = {
      format: "video-canvas/canvas",
      version: 1,
      assets: {},
      canvas: {
        title: "剧本链接",
        edges: [],
        nodes: [
          {
            id: "script",
            type: "canvas",
            position: { x: 240, y: 200 },
            data: { kind: "script", label: "对白", text: `[拍摄计划](${url})` },
          },
        ],
      },
    };
    await (await chooser).setFiles({
      name: "links.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (value) => {
        process.env.LINK_STUDIO_TEXT_LINKS =
          (process.env.LINK_STUDIO_TEXT_LINKS ?? "") + value + "\n";
      };
    });
    const link = page.getByRole("link", { name: "拍摄计划" });
    await expect(link).toHaveAttribute("href", url);
    await link.click();
    await link.press("Enter");
    await expect
      .poll(() => app.evaluate(() => process.env.LINK_STUDIO_TEXT_LINKS))
      .toBe(`${url}\n${url}\n`);
    await expect(link).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("文本节点从放大入口编辑格式，关闭后渲染并跨重开恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-text-format-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "文本格式验收");
    await addCanvasNode(page, "文本");
    const strip = page.getByRole("toolbar", { name: /的功能区$/ });
    await expect(strip).toHaveCount(0);
    await page.locator(".canvas-text-preview").dblclick();
    const dialog = page.getByRole("dialog");
    const editor = dialog.getByRole("textbox", { name: "文本内容" });
    await editor.fill("镜头记录");
    await editor.press("ControlOrMeta+a");
    for (const action of ["加粗", "二级标题", "斜体", "撤销", "重做"])
      await dialog.getByRole("button", { name: action, exact: true }).click();
    await editor.press("Escape");
    await expect(
      page.locator(".canvas-text-preview h3 strong em, .canvas-text-preview h3 em strong"),
    ).toHaveText("镜头记录");
    await expect
      .poll(async () => {
        const node = projectCanvas((await latestSnapshot(root)).canvas).nodes[0];
        return node?.type === "creative" ? node.data.text.trimEnd() : "";
      })
      .toBe("## ***镜头记录***");
    await expect(strip.getByRole("button")).toHaveCount(2);
    const checkAnchor = () =>
      expect
        .poll(() =>
          strip.evaluate((bar) => {
            const card = document
              .querySelector(".react-flow__node.selected")!
              .getBoundingClientRect();
            const rect = bar.getBoundingClientRect();
            const scale = new DOMMatrix(
              getComputedStyle(document.querySelector(".react-flow__viewport")!).transform,
            ).a;
            return Math.max(
              Math.abs(card.x + card.width / 2 - rect.x - rect.width / 2),
              Math.abs(card.top - rect.bottom - (28 * scale + 16)),
            );
          }),
        )
        .toBeLessThan(1);
    await checkAnchor();
    const zoom = page.locator(".react-flow__viewport"),
      previousZoom = await zoom.getAttribute("style");
    await chooseCanvasZoom(page, "缩小");
    await expect(zoom).not.toHaveAttribute("style", previousZoom!);
    await checkAnchor();
    await page.evaluate(() =>
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (value: string) => {
          document.body.dataset.copiedText = value;
        },
      }),
    );
    await strip.getByRole("button", { name: "复制文本" }).click();
    await expect(page.getByText("已复制文本", { exact: true })).toBeVisible();
    const saved = projectCanvas((await latestSnapshot(root)).canvas).nodes[0];
    expect(await page.locator("body").getAttribute("data-copied-text")).toBe(
      saved?.type === "creative" ? saved.data.text : undefined,
    );
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async () => {
          throw new Error("denied");
        },
      });
      document.execCommand = () => false;
    });
    await strip.getByRole("button", { name: "复制文本" }).click();
    await expect(page.getByText("复制失败，请手动选中复制")).toBeVisible();
    await strip.getByRole("button", { name: "放大预览" }).click();
    await expect(dialog.locator(".text-draft h2 strong em, .text-draft h2 em strong")).toHaveText(
      "镜头记录",
    );
    await editor.press("Escape");
    const heading = await page.locator(".react-flow__node.selected header strong").boundingBox();
    if (!heading) throw Error("缺少标题");
    const drag = { x: heading.x + heading.width / 2, y: heading.y + heading.height / 2 };
    await page.mouse.move(drag.x, drag.y);
    await page.mouse.down();
    try {
      await page.mouse.move(drag.x + 36, drag.y + 8, { steps: 5 });
      await expect(strip).toHaveCount(0);
    } finally {
      await page.mouse.up();
    }
    await checkAnchor();
    await expect
      .poll(
        async () =>
          (await page.locator(".react-flow__node.selected header strong").boundingBox())?.x,
      )
      .toBeGreaterThan(heading.x + 15);
    await projectAction(page, "所选节点属性");
    const properties = page.getByRole("region", { name: "节点属性" });
    const generate = properties.getByRole("button", { name: "生成内容", exact: true });
    await expect(generate).toBeEnabled();
    await generate.focus();
    await expect(generate).toBeFocused();
    await generate.press("Enter");
    await expect(properties).toBeHidden();
    await expect(page.getByRole("region", { name: "生成确认" })).toBeVisible();
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^文本格式验收/ }).click();
    await reopened.locator(".canvas-text-preview").dblclick();
    const restored = reopened.getByRole("dialog");
    await expect(restored.locator(".text-draft h2 strong em, .text-draft h2 em strong")).toHaveText(
      "镜头记录",
    );
    await restored.getByRole("button", { name: "关闭", exact: true }).click();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("照片的八种 EXIF 方向保持显示画幅，镜像旋转的四宫格按可见象限切分", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-exif-"));
  let app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 32;
      const context = canvas.getContext("2d")!;
      for (const [index, color] of ["#000000", "#555555", "#aaaaaa", "#ffffff"].entries()) {
        context.fillStyle = color;
        context.fillRect((index % 2) * 32, Math.floor(index / 2) * 16, 32, 16);
      }
      return canvas.toDataURL("image/jpeg", 1).split(",")[1]!;
    });
    const files = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const file = join(root, `照片${index + 1}.jpg`);
        await writeFile(
          file,
          orientedJpeg(Buffer.from(encoded, "base64"), index + 1, index % 2 === 0),
        );
        return file;
      }),
    );
    await createCanvasProject(page, "照片方向");
    await chooseCanvasFiles(
      page,
      page.getByRole("button", { name: /^上传素材 图片、视频、音频/ }),
      files,
    );
    const frames = (view: Page) =>
      view
        .locator('.react-flow__node article:has(img[alt$=".jpg"])')
        .evaluateAll((cards) =>
          Object.fromEntries(
            cards.map((card) => [
              card.querySelector("img")!.alt,
              [getComputedStyle(card).width, getComputedStyle(card).height],
            ]),
          ),
        );
    const expected = Object.fromEntries(
      files.map((_, index) => [
        `照片${index + 1}.jpg`,
        index < 4 ? ["648px", "324px"] : ["324px", "648px"],
      ]),
    );
    await expect.poll(() => frames(page)).toEqual(expected);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.nodes.length).toBe(8);
    const state = await latestSnapshot(root);
    for (const [index, file] of files.entries()) {
      const asset = Object.values(state.assets).find(
        (asset) => asset.displayName === `照片${index + 1}.jpg`,
      )!;
      expect(asset.metadata).toMatchObject({ width: 64, height: 32, orientation: index + 1 });
      expect(asset.sha256).toBe(
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      );
    }
    await app.close();
    const directory = await projectDirectory(root);
    const { commitHash: originalHash, ...legacy } = await latestSnapshot(root);
    for (const asset of Object.values(legacy.assets)) delete asset.metadata.orientation;
    const revision = String(legacy.revision).padStart(12, "0"),
      legacyHash = contentHash(legacy);
    await writeFile(
      join(directory, "state", `${revision}-${legacyHash}.json`),
      JSON.stringify({ ...legacy, commitHash: legacyHash }),
    );
    await rm(join(directory, "state", `${revision}-${originalHash}.json`));
    app = await launchCanvas(root);
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: /^照片方向/ }).click();
    await expect.poll(() => frames(reopened)).toEqual(expected);
    await chooseCanvasZoom(reopened, "适应画布");
    await reopened
      .locator(".react-flow__node")
      .filter({ has: reopened.getByText("照片7", { exact: true }) })
      .locator("header strong")
      .click();
    await reopened.getByRole("button", { name: "宫格切分" }).click();
    await reopened.getByRole("menuitem", { name: "4 宫格 (2×2)" }).click();
    const evidence = join(process.cwd(), "test-results", "canvas-jpeg-orientation");
    await mkdir(evidence, { recursive: true });
    await reopened.locator(".split-stage").screenshot({ path: join(evidence, "grid-preview.png") });
    await reopened.getByRole("button", { name: "确认切分 · 4 格" }).click();
    await expect(reopened.locator('img[alt^="grid-"]')).toHaveCount(4);
    const tiles = Object.values((await latestSnapshot(root)).assets).filter((asset) =>
      asset.displayName.startsWith("grid-"),
    );
    expect(tiles).toHaveLength(4);
    const ffmpeg = join(
      process.cwd(),
      "out/media",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    const tones: Record<string, number> = {
      "grid-1-1.png": 255,
      "grid-1-2.png": 85,
      "grid-2-1.png": 170,
      "grid-2-2.png": 0,
    };
    for (const tile of tiles) {
      expect(tile.metadata).toMatchObject({ width: 16, height: 32 });
      const rgba = await runMediaProcess(ffmpeg, [
        "-v",
        "error",
        "-i",
        join(directory, "assets", "sha256", tile.sha256.slice(0, 2), tile.sha256),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "pipe:1",
      ]);
      const tone = tones[tile.displayName]!;
      expect(rgba).toEqual(Buffer.alloc(16 * 32 * 4, Buffer.from([tone, tone, tone, 255])));
      await writeFile(join(evidence, tile.displayName + ".rgba"), rgba);
    }
    for (const [index, file] of files.entries())
      await writeFile(join(evidence, `source-${index + 1}.jpg`), await readFile(file));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("图片节点宫格拆图、批量撤销与重开恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-grid-e2e-"));
  const image = join(root, "grid.png");
  let application = await launchCanvas(root, image);
  try {
    const page = await application.firstWindow();
    const sample = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 20;
      canvas.height = 12;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无像素上下文");
      for (let row = 0; row < canvas.height; row++) {
        for (let col = 0; col < canvas.width; col++) {
          context.fillStyle = `rgb(${col * 10}, ${row * 18}, ${(row + col) * 8})`;
          context.fillRect(col, row, 1, 1);
        }
      }
      return canvas.toDataURL().slice("data:image/png;base64,".length);
    });
    await writeFile(image, Buffer.from(sample, "base64"));
    await createCanvasProject(page, "宫格验收");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将grid.png加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const trigger = page.getByRole("button", { name: "宫格切分" });
    await trigger.click();
    const custom = page.getByRole("menuitem", { name: "自定义" });
    await custom.hover();
    const picker = page.getByRole("group", { name: "宫格尺寸" });
    await expect(picker.getByRole("button")).toHaveCount(25);
    await expect(picker.getByRole("button", { name: "1×1" })).toBeDisabled();
    const rowBounds = await custom.boundingBox(),
      pickerBounds = await picker.boundingBox();
    if (!rowBounds || !pickerBounds) throw Error("缺少自定义宫格或子菜单");
    await page.mouse.move(rowBounds.x + rowBounds.width - 2, rowBounds.y + rowBounds.height / 2, {
      steps: 6,
    });
    await page.mouse.move(pickerBounds.x + 2, rowBounds.y + rowBounds.height / 2, { steps: 5 });
    await picker.getByRole("button", { name: "2×3" }).hover();
    await expect(picker.locator("[data-lit=true]")).toHaveCount(6);
    await picker.getByRole("button", { name: "2×3" }).click();
    await expect(page.getByRole("button", { name: "确认切分 · 6 格" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".split-stage")).toHaveCount(0);
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
    await expect(trigger).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await trigger.click();
    await page.getByRole("menuitem", { name: "4 宫格 (2×2)" }).click();
    const line = page.getByRole("slider", { name: "第 1 条竖线" });
    await line.press("Shift+ArrowRight");
    await expect(line).toHaveAttribute("aria-valuenow", "55");
    await page.getByRole("button", { name: "重置均分" }).click();
    await expect(line).toHaveAttribute("aria-valuenow", "50");
    await line.press("ArrowRight");
    await expect(line).toHaveAttribute("aria-valuenow", "51");
    const stage = await page.locator(".split-stage").boundingBox();
    if (!stage) throw new Error("缺少切图覆盖层");
    expect(stage.width / stage.height).toBeCloseTo(20 / 12, 2);
    await expect(page.locator(".creative-card footer")).toBeHidden();
    const pointerY = stage.y + stage.height * 0.25;
    await page.mouse.move(stage.x + stage.width * 0.51, pointerY);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width * 0.65, pointerY, { steps: 5 });
    await page.mouse.up();
    await expect(line).toHaveAttribute("aria-valuenow", "65");
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await page.screenshot({ path: "test-results/canvas-grid-split.png" });
    const waitingIds = page.evaluate(
      () =>
        new Promise<string[]>((resolve, reject) => {
          const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error("没有显示四个切片占位节点和来源线"));
          }, 5000);
          const observer = new MutationObserver(() => {
            const pending = [
              ...document.querySelectorAll(
                '.react-flow__node:has(progress[aria-label="正在切分"])',
              ),
            ];
            if (pending.length !== 4 || document.querySelectorAll(".react-flow__edge").length !== 4)
              return;
            observer.disconnect();
            clearTimeout(timeout);
            resolve(pending.map((node) => node.getAttribute("data-id") ?? "").sort());
          });
          observer.observe(document.body, { subtree: true, childList: true });
        }),
    );
    await page.getByRole("button", { name: "确认切分 · 4 格" }).click();
    await expect(line).toBeHidden();
    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);
    const pendingIds = await waitingIds;
    await expect
      .poll(() =>
        page.locator(".react-flow__node:has(.canvas-image-layers img)").evaluateAll((cards) =>
          cards
            .filter((card) => card.querySelector("strong")?.textContent !== "grid")
            .map((card) => card.getAttribute("data-id"))
            .sort(),
        ),
      )
      .toEqual(pendingIds);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(4);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^宫格验收/ }).click();
    await expect(reopened.locator(".react-flow__node")).toHaveCount(5);
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(4);
    const previews = reopened.locator('.react-flow__node .canvas-image-layers img:not([alt=""])');
    await expect(previews).toHaveCount(5);
    const saved = await latestSnapshot(root);
    const restored = projectCanvas(saved.canvas).nodes.filter((node) => node.type === "creative");
    const source = restored.find((node) => node.data.label === "grid");
    if (!source) throw new Error("缺少源图片");
    const positions = await previews.evaluateAll(async (images) => {
      return Promise.all(
        images.map(async (element) => {
          const image = element as HTMLImageElement;
          const { alt: name } = image;
          image.loading = "eager";
          await image.decode();
          const card = image.closest("article");
          return {
            name,
            id: card?.closest(".react-flow__node")?.getAttribute("data-id"),
            label: card?.querySelector("strong")?.textContent,
            width: image.naturalWidth,
            height: image.naturalHeight,
            frame: [card?.offsetWidth, card?.offsetHeight],
          };
        }),
      );
    });
    for (const part of positions) {
      const node = restored.find((item) => item.id === part.id);
      const asset = node?.data.assetId && saved.assets[node.data.assetId];
      if (!node || !asset)
        throw new Error(`切图节点 ${part.id} 缺少持久化素材 ${node?.data.assetId}`);
      expect(part.name).toBe(asset.displayName);
      const match = asset.displayName.match(/^grid-([12])-([12])\.png$/);
      if (node.id === source.id) expect(asset.displayName).toBe("grid.png");
      else expect(match).not.toBeNull();
      const row = Number(match?.[1] ?? 1) - 1;
      const col = Number(match?.[2] ?? 1) - 1;
      expect([part.width, part.height]).toEqual(match ? [col ? 7 : 13, 6] : [20, 12]);
      if (match) {
        expect(part.label).toBe(`grid ${row + 1}-${col + 1}`);
        expect(part.frame).toEqual([col ? 378 : 702, 324]);
        expect(node.data.uploaded).toBe(true);
        expect(node.position).toEqual({
          x: source.position.x + 620 + col * 782,
          y: source.position.y - 182 + row * 364,
        });
      }
      const expected: number[] = [];
      for (let line = 0; line < part.height; line++) {
        for (let column = 0; column < part.width; column++) {
          const sourceCol = column + col * 13;
          const sourceRow = line + row * 6;
          expected.push(sourceCol * 10, sourceRow * 18, (sourceRow + sourceCol) * 8, 255);
        }
      }
      const pixels = await runMediaProcess(
        join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg"),
        [
          "-v",
          "error",
          "-i",
          join(
            await projectDirectory(root),
            "assets",
            "sha256",
            asset.sha256.slice(0, 2),
            asset.sha256,
          ),
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgba",
          "pipe:1",
        ],
      );
      expect(pixels).toEqual(Buffer.from(expected));
    }
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("图片节点涂鸦标注生成派生图片、来源连线并支持重开恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-doodle-e2e-"));
  const image = join(root, "doodle.png");
  let application = await launchCanvas(root, image);
  try {
    const page = await application.firstWindow();
    const blank = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      return canvas.toDataURL().slice("data:image/png;base64,".length);
    });
    await writeFile(image, Buffer.from(blank, "base64"));
    await createCanvasProject(page, "涂鸦验收");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将doodle.png加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await chooseCanvasZoom(page, "适应画布");
    await page.getByRole("button", { name: "图片编辑", exact: true }).click();
    const dialog = page.getByRole("toolbar", { name: "图片标注工具栏" });
    await expect(dialog).toBeVisible();
    await expect
      .poll(async () => Math.abs((await dialog.boundingBox())!.width - 600))
      .toBeLessThanOrEqual(4);
    await expect(dialog).toHaveCSS("height", "40px");
    await expect(dialog.getByRole("button", { name: "画笔" })).toHaveCSS("font-size", "14px");
    const save = dialog.getByRole("button", { name: "保存", exact: true });
    await save.click();
    await expect(page.getByText("还没有标注内容")).toBeVisible();
    const thickness = dialog.getByRole("slider");
    await thickness.press("End");
    await expect(thickness).toHaveValue("20");
    await thickness.press("Home");
    await expect(thickness).toHaveValue("2");
    for (let step = 0; step < 4; step++) await thickness.press("ArrowRight");
    await expect(thickness).toHaveValue("6");
    const stage = page.getByLabel("涂鸦画布");
    const bounds = await stage.boundingBox();
    if (!bounds) throw new Error("涂鸦画布未显示");
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.65, {
      steps: 8,
    });
    await page.mouse.up();
    await dialog.getByRole("button", { name: "撤销" }).click();
    await expect(dialog.getByRole("button", { name: "撤销" })).toBeDisabled();
    await dialog.getByRole("button", { name: "重做" }).click();
    await dialog.getByRole("button", { name: "文字" }).click();
    await stage.click({ position: { x: 10, y: 10 } });
    await page.locator("textarea[data-fabric]").fill("标注");
    await dialog.getByRole("button", { name: "框选" }).click();
    await dialog.getByRole("button", { name: "颜色", exact: true }).click();
    const palette = page.getByRole("dialog", { name: "标注颜色" });
    await expect(palette.getByRole("button")).toHaveCount(8);
    const colorTrigger = dialog.getByRole("button", { name: "颜色", exact: true });
    const triggerRect = await colorTrigger.boundingBox();
    await expect
      .poll(async () =>
        Math.round((await palette.boundingBox())!.y - triggerRect!.y - triggerRect!.height),
      )
      .toBe(8);
    await palette.getByRole("button", { name: "颜色 #facc15" }).press("Enter");
    await expect(palette).toBeHidden();
    await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.75);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.95, {
      steps: 8,
    });
    await page.mouse.up();
    await dialog.getByRole("button", { name: "撤销" }).click();
    await dialog.getByRole("button", { name: "重做" }).click();
    await save.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(1);
    const snapshot = await latestSnapshot(root);
    const original = Object.values(snapshot.assets).find(
      ({ displayName, origin }) => displayName === "doodle.png" && origin !== "derived",
    );
    expect(original).toBeDefined();
    const [sourceNode, firstCopy] = projectCanvas(snapshot.canvas).nodes;
    await expect(page.locator(".react-flow__node.selected")).toHaveAttribute(
      "data-id",
      sourceNode!.id,
    );
    await page.getByRole("button", { name: "图片编辑", exact: true }).click();
    await expect(save).toBeEnabled();
    await page.mouse.move(bounds.x + 24, bounds.y + 30);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 60, bounds.y + 66, { steps: 6 });
    await page.mouse.up();
    await save.click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(2);
    const secondCopy = projectCanvas((await latestSnapshot(root)).canvas).nodes[2]!;
    expect(secondCopy.data.label).toBe(`${firstCopy!.data.label} 2`);
    expect(secondCopy.position).toEqual({
      x: firstCopy!.position.x,
      y: firstCopy!.position.y + 364,
    });
    await expect(page.locator(".react-flow__node.selected")).toHaveAttribute(
      "data-id",
      sourceNode!.id,
    );
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(2);
    expect(Object.values(snapshot.assets)).toContainEqual(
      expect.objectContaining({
        origin: "derived",
        metadata: expect.objectContaining({
          annotation: "doodle",
          sourceAssetId: original?.assetId,
        }),
      }),
    );
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^涂鸦验收/ }).click();
    await expect(reopened.locator(".react-flow__node")).toHaveCount(3);
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(2);
    await expect(reopened.locator(".react-flow__node img")).toHaveCount(3);
    const derivedImage = reopened.locator(
      `.react-flow__node[data-id="${firstCopy!.id}"] img[alt="doodle.png"]`,
    );
    const counts = await derivedImage.evaluate(async (element) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = (element as HTMLImageElement).currentSrc;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法检查派生图");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, 256, 256).data;
      let yellow = 0;
      let redText = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] === 250 && pixels[index + 1] === 204 && pixels[index + 2] === 21)
          yellow++;
        if (index < 4 * 256 * 64 && pixels[index] === 239 && pixels[index + 1] === 68) redText++;
      }
      return { yellow, redText };
    });
    expect(counts.yellow).toBeGreaterThan(30);
    expect(counts.redText).toBeGreaterThan(5);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("大图缩小后中文标注预编辑、确认和换行形成一步撤销", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-doodle-composition-"));
  const image = join(root, "大图.png");
  const application = await launchCanvas(root, image);
  const output = join(process.cwd(), "test-results", "doodle-composition");
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page);
    const png = Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 5000;
        canvas.height = 2500;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#233852";
        context.fillRect(0, 0, 2500, 2500);
        context.fillStyle = "#92aeb9";
        context.fillRect(2500, 0, 2500, 1250);
        return canvas.toDataURL().split(",")[1]!;
      }),
      "base64",
    );
    await mkdir(output, { recursive: true });
    await writeFile(image, png);
    await writeFile(join(output, "input.png"), png);
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将大图.png加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await chooseCanvasZoom(page, "缩放到 100%");
    await expect
      .poll(() =>
        page
          .locator(".react-flow__viewport")
          .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a),
      )
      .toBe(1);
    await chooseCanvasZoom(page, "缩小");
    await page.getByRole("button", { name: "图片编辑", exact: true }).click();
    const sample = await annotateWithComposition(page);
    expect(sample.zoom).toBeLessThan(1);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges.length).toBe(1);
    const file = Object.values((await latestSnapshot(root)).assets).find(
      (asset) => asset.origin === "derived",
    )!;
    expect(file.metadata).toMatchObject({ width: 4096, height: 2048 });
    await writeFile(
      join(output, "desktop-result.png"),
      await readFile(
        join(
          await projectDirectory(root),
          "assets",
          "sha256",
          file.sha256.slice(0, 2),
          file.sha256,
        ),
      ),
    );
    await writeFile(join(output, "desktop-geometry.json"), JSON.stringify(sample, null, 2));
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("图片标注在导出前占位、编码失败清理、删除中止及落盘失败原节点重试", async () => {
  test.setTimeout(75_000);
  const root = await mkdtemp(join(tmpdir(), "link-doodle-lifecycle-"));
  const image = join(root, "底图.png");
  const app = await launchCanvas(root, image);
  try {
    await writeFile(image, await readFile(join(process.cwd(), "resources/icons/icon-32.png")));
    const page = await app.firstWindow();
    await page.setViewportSize(compactViewport);
    await createCanvasProject(page);
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将底图.png加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await chooseCanvasZoom(page, "适应画布");
    const cards = page.locator(".react-flow__node"),
      edges = page.locator(".react-flow__edge");
    const source = await cards.first().getAttribute("data-id");
    const toolbar = page.getByRole("toolbar", { name: "图片标注工具栏" });
    const save = toolbar.getByRole("button", { name: "保存", exact: true });
    let drawingRect: Awaited<ReturnType<Locator["boundingBox"]>> = null;
    const prepare = async () => {
      await page.getByTestId(`rf__node-${source}`).click();
      await page.getByRole("button", { name: "图片编辑", exact: true }).click();
      await expect(save).toBeEnabled();
      await toolbar.getByRole("button", { name: "框选" }).click();
      const bounds = (await page.getByLabel("涂鸦画布", { exact: true }).boundingBox())!;
      drawingRect = bounds;
      await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.25);
      await page.mouse.down();
      try {
        await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.75, {
          steps: 8,
        });
      } finally {
        await page.mouse.up();
      }
      await expect(toolbar.getByRole("button", { name: "撤销" })).toBeEnabled();
    };
    const holdExport = () =>
      page.evaluate(() => {
        const prototype = HTMLCanvasElement.prototype,
          original = prototype.toBlob;
        prototype.toBlob = function (callback, ...args) {
          prototype.toBlob = original;
          Object.assign(window, {
            releaseExport: (fail: boolean) =>
              fail ? callback(null) : original.call(this, callback, ...args),
          });
        };
      });
    const releaseExport = async (fail: boolean) => {
      await page.waitForFunction(() => typeof Reflect.get(window, "releaseExport") === "function");
      await page.evaluate((fail) => {
        Reflect.get(window, "releaseExport")(fail);
        Reflect.deleteProperty(window, "releaseExport");
      }, fail);
    };
    const stored = async () => projectCanvas((await latestSnapshot(root)).canvas);
    const assetCount = async () => Object.keys((await latestSnapshot(root)).assets).length;
    const pending = cards.filter({
      has: page.getByRole("status").filter({ hasText: /上传中|处理中/ }),
    });
    await prepare();
    await holdExport();
    await save.click();
    await expect(toolbar).toBeHidden();
    await expect(pending.getByRole("status")).toContainText("上传中0%");
    await expect(edges).toHaveCount(1);
    await expect(page.locator(".react-flow__node.selected")).toHaveAttribute("data-id", source!);
    await expect.poll(async () => (await stored()).nodes.length).toBe(1);
    await releaseExport(true);
    await expect(page.getByText("涂鸦图导出失败", { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(1);
    await expect(edges).toHaveCount(0);
    expect(await assetCount()).toBe(1);

    await prepare();
    await holdExport();
    await save.click();
    await expect(pending).toHaveCount(1);
    const removedId = await pending.getAttribute("data-id");
    await pending.click();
    await expect(page.locator(".react-flow__node.selected")).toHaveAttribute("data-id", removedId!);
    await page.keyboard.press("Backspace");
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-id", source!);
    await releaseExport(false);
    await expect(edges).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    const shell = page.getByTestId(`rf__node-${removedId}`);
    await expect(shell.getByRole("alert")).toHaveText("上传已中断，请删除后重新上传");
    await expect(shell.getByRole("button", { name: "重试" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(shell).toHaveCount(0);

    await prepare();
    await holdCanvasFile(app, "failSync");
    await save.click();
    await expect(toolbar).toBeHidden();
    await expect(pending.getByRole("status")).toContainText("处理中");
    const retryId = await pending.getAttribute("data-id");
    const retryCard = page.getByTestId(`rf__node-${retryId}`);
    await releaseCanvasFile(app);
    await expect(retryCard.getByRole("alert")).toContainText("上传失败，请重试");
    await expect.poll(async () => (await stored()).edges.length).toBe(1);
    expect(await assetCount()).toBe(1);
    await retryCard.getByRole("button", { name: "重试" }).click();
    await expect(retryCard.locator("img")).toHaveCount(1);
    await expect
      .poll(async () => (await stored()).nodes.find((node) => node.id === retryId)?.data)
      .toMatchObject({ assetId: expect.any(String), uploaded: true });
    expect(await assetCount()).toBe(2);
    await expect(edges).toHaveCount(1);

    const file = Object.values((await latestSnapshot(root)).assets).find(
      (asset) => asset.origin === "derived",
    )!;
    expect(file.displayName).toBe("doodle.png");
    const evidence = join(process.cwd(), "test-results", "doodle-lifecycle");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "desktop-geometry.json"),
      JSON.stringify({ rect: drawingRect, dpr: await page.evaluate(() => devicePixelRatio) }),
    );
    await writeFile(
      join(evidence, "desktop-result.png"),
      await readFile(
        join(
          await projectDirectory(root),
          "assets",
          "sha256",
          file.sha256.slice(0, 2),
          file.sha256,
        ),
      ),
    );

    await prepare();
    await holdCanvasFile(app, "sync");
    await save.click();
    await expect(pending.getByRole("status")).toContainText("处理中");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(cards).toHaveCount(2);
    await expect(edges).toHaveCount(1);
    await releaseCanvasFile(app);
    await prepare();
    await save.click();
    await expect.poll(async () => (await stored()).edges.length).toBe(2);
    expect(await assetCount()).toBe(3);
    await prepare();
    await holdCanvasFile(app, "sync");
    await save.click();
    await expect(pending.getByRole("status")).toContainText("处理中");
    await prepare();
    await save.click();
    await expect(toolbar).toBeHidden();
    await expect(pending).toHaveCount(2);
    await expect(edges).toHaveCount(4);
    await expect.poll(async () => (await stored()).edges.length).toBe(2);
    await releaseCanvasFile(app);
    await expect.poll(async () => (await stored()).edges.length).toBe(4);
    expect(await assetCount()).toBe(5);
    const copies = (await stored()).nodes.filter((node) => node.id !== source);
    expect(new Set(copies.map((node) => node.position.y)).size).toBe(4);
    expect(new Set(copies.map((node) => node.type === "creative" && node.data.assetId)).size).toBe(
      4,
    );
  } finally {
    await releaseCanvasFile(app).catch(() => {});
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("图片扩图只发送透明底图，生成结果和来源连线重开可恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-outpaint-e2e-"));
  const image = join(root, "outpaint.png");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=";
  const requests: Buffer[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/images/edits") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(Buffer.concat(chunks));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  let application: Awaited<ReturnType<typeof launchCanvas>> | undefined;
  try {
    await writeFile(image, Buffer.from(png, "base64"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test endpoint");
    application = await launchCanvas(root, image);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      if (!list.ok) throw new Error(list.code);
      const plugin = list.value.plugins.find(({ key }) => key === "openai-image");
      if (!plugin) throw new Error("Missing image adapter");
      const result = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-image-key",
        fields: {
          label: "扩图测试渠道",
          model: "gpt-image-1",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!result.ok) throw new Error(result.code);
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page, "扩图验收");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将outpaint.png加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await page.getByRole("button", { name: "扩图", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "图片扩图" });
    await dialog.getByLabel("画框比例").selectOption("自由");
    await dialog.getByLabel("宽度倍数").selectOption("2");
    await dialog.getByLabel("高度倍数").selectOption("1");
    await dialog.getByRole("textbox", { name: "补画内容（选填）" }).fill("延展街景");
    await expect(dialog.getByRole("combobox", { name: "图片模型" })).toContainText("gpt-image-1");
    await expect(dialog.getByText(/底图 6 × 2/)).toBeVisible();
    expect(requests).toHaveLength(0);
    await dialog.getByRole("button", { name: "确认扩图" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => requests.length).toBe(1);
    const body = requests[0];
    if (!body) throw new Error("Missing image edit request");
    const start = body.indexOf(Buffer.from("89504e470d0a1a0a", "hex"));
    expect(start).toBeGreaterThan(0);
    expect(body.readUInt32BE(start + 16)).toBe(6);
    expect(body.readUInt32BE(start + 20)).toBe(2);
    expect(body[start + 25]).toBe(6);
    expect(body.includes(Buffer.from(png, "base64"))).toBe(false);
    await expect(page.locator(".react-flow__node img")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    const snapshot = await latestSnapshot(root);
    const assets = Object.values(snapshot.assets);
    const original = assets.find(({ displayName }) => displayName === "outpaint.png");
    expect(original).toBeDefined();
    expect(assets).toContainEqual(
      expect.objectContaining({
        origin: "derived",
        metadata: expect.objectContaining({
          annotation: "outpaint",
          sourceAssetId: original?.assetId,
        }),
      }),
    );
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^扩图验收/ }).click();
    await expect(reopened.locator(".react-flow__node img")).toHaveCount(2);
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(1);
  } finally {
    await application?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("资产库逐文件上传可取消、移除失败卡并从原文件重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-picker-upload-"));
  const files = [
    "原图.png",
    "可修复.png",
    "丢弃.png",
    ...Array.from({ length: 4 }, (_, index) => `重复${index + 1}.png`),
  ].map((name) => join(root, name));
  const red = await readFile(join(process.cwd(), "resources/icons/icon-32.png"));
  const blue = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=",
    "base64",
  );
  for (const [index, file] of files.entries())
    await writeFile(file, index === 1 || index === 2 ? "not an image" : red);
  const app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page, "队列验收");
    await page.getByRole("button", { name: "资产库", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "资产库" }),
      input = picker.getByLabel("选择要上传的文件");
    await input.setInputFiles(files.slice(0, 3));
    const broken = picker.getByRole("group", { name: "可修复.png", exact: true });
    await expect(broken.getByRole("alert")).toBeVisible();
    await expect(picker.getByText("已选择 1 个素材")).toBeVisible();
    const discard = picker.getByRole("group", { name: "丢弃.png" });
    await discard.getByRole("button", { name: "移除" }).click();
    await expect(discard).toHaveCount(0);
    await picker.getByRole("textbox", { name: "搜索文件名" }).fill("无结果");
    await expect(broken).toHaveCount(0);
    await picker.getByRole("tab", { name: "生成历史" }).click();
    await expect(broken).toHaveCount(0);
    await picker.getByRole("tab", { name: "个人资产库" }).click();
    await writeFile(files[1]!, blue);
    await broken.getByRole("button", { name: "重试" }).click();
    await expect(picker.getByText("已选择 2 个素材")).toBeVisible();
    await expect(broken).toHaveCount(0);
    await input.setInputFiles(files.slice(3));
    const queued = picker.getByRole("group", { name: "重复4.png", exact: true });
    await expect(queued.getByText("等待上传")).toBeVisible();
    await expect(queued.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    await expect(picker.getByRole("group", { name: "处理重复素材" })).toHaveCount(3);
    await picker
      .getByRole("group", { name: "重复1.png", exact: true })
      .getByRole("button", { name: "取消上传" })
      .click();
    await expect(queued.getByText("处理中…")).toBeVisible();
    await expect(picker.getByRole("group", { name: "重复1.png", exact: true })).toHaveCount(0);
    await picker.getByRole("button", { name: "确认", exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
    await expect
      .poll(async () =>
        Object.values((await latestSnapshot(root)).assets)
          .map((item) => item.displayName)
          .sort(),
      )
      .toEqual(["原图.png", "可修复.png"]);
    await page.getByRole("button", { name: "资产库", exact: true }).click();
    await expect(picker.locator(".asset-upload-card")).toHaveCount(0);
    await expect(picker.getByText("已选择 0 个素材")).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("个人资产库登记重试不重传，源项目移走后跨项目预览与引入可重开", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-global-picker-"));
  const file = join(root, "跨项目主图.png"),
    bytes = await readFile(join(process.cwd(), "resources/icons/icon-32.png"));
  await writeFile(file, bytes);
  let app = await launchCanvas(root);
  try {
    let page = await app.firstWindow();
    const create = async (name: string) => {
      await createCanvasProject(page, name);
    };
    const enter = async () => {
      await page.getByRole("button", { name: "资产库", exact: true }).click();
      return page.getByRole("dialog", { name: "资产库" });
    };
    await create("原项目");
    await projectAction(page, "项目文件");
    await page.getByLabel("导入方式").selectOption("reference");
    await page.getByRole("button", { name: "新建资产库文件夹" }).click();
    const folderForm = page.getByRole("dialog", { name: "新建文件夹" });
    await folderForm.getByRole("button", { name: "创建" }).click();
    await expect(folderForm.getByRole("alert")).toHaveText("请输入文件夹名称");
    await folderForm.getByLabel("文件夹名称").fill(" 角色图 ");
    await folderForm.getByRole("button", { name: "创建" }).click();
    await expect(folderForm).toHaveCount(0);
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    let picker = await enter();
    const folder = () => picker.getByRole("button", { name: "打开文件夹 角色图" });
    await folder().click();
    await expect(picker.getByText("这个文件夹是空的")).toBeVisible();
    const sql = (statement: string) => {
      const db = new DatabaseSync(join(root, "personal-library", "items.sqlite"));
      try {
        db.exec(statement);
      } finally {
        db.close();
      }
    };
    sql(
      "CREATE TRIGGER fail_register BEFORE INSERT ON library_items BEGIN SELECT RAISE(ABORT,'fixture');END;",
    );
    await picker.getByLabel("选择要上传的文件").setInputFiles(file);
    const failed = picker.getByRole("group", { name: "跨项目主图.png" });
    await expect(failed.getByRole("alert")).toHaveText("登记到个人资产库失败，请重试");
    await expect(picker.getByText("已选择 0 个素材")).toBeVisible();
    await expect(picker.getByRole("button", { name: "跨项目主图.png", exact: true })).toHaveCount(
      0,
    );
    await picker
      .getByRole("navigation", { name: "当前位置" })
      .getByRole("button", { name: "个人资产库" })
      .click();
    await expect(failed).toHaveCount(0);
    await folder().click();
    await rm(file);
    sql("DROP TRIGGER fail_register");
    await failed.getByRole("button", { name: "重试" }).click();
    await expect(picker.getByText("已选择 1 个素材")).toBeVisible();
    await expect(failed).toHaveCount(0);
    const original = await latestSnapshot(root);
    expect(Object.keys(original.assets)).toHaveLength(1);
    expect(Object.values(original.assets)[0]!.storage.kind).toBe("external");
    await picker.getByRole("button", { name: "关闭", exact: true }).click();
    await projectAction(page, "关闭项目");
    await rename(await projectDirectory(root), join(root, "移动后的项目"));
    await create("目标项目");
    picker = await enter();
    await expect(folder()).toContainText("1 项");
    await expect(picker.getByRole("button", { name: "跨项目主图.png", exact: true })).toHaveCount(
      0,
    );
    await picker.getByRole("textbox", { name: "搜索文件名" }).fill("跨项目");
    const card = picker.getByRole("button", { name: "跨项目主图.png", exact: true });
    await expect
      .poll(() =>
        card
          .locator("..")
          .locator("img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(32);
    await card.click();
    expect((await latestSnapshot(root)).assets).toEqual({});
    await picker.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
    await expect
      .poll(async () => projectCanvas((await latestSnapshot(root)).canvas).nodes.length)
      .toBe(1);
    const target = await latestSnapshot(root),
      records = Object.values(target.assets);
    expect(records).toHaveLength(1);
    expect(records[0]!.assetId).not.toBe(Object.keys(original.assets)[0]);
    expect(records[0]!.importMode).toBe("copy");
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(records[0]!.sha256).toBe(hash);
    expect(
      await readFile(
        join(await projectDirectory(root), "assets", "sha256", hash.slice(0, 2), hash),
      ),
    ).toEqual(bytes);
    await app.close();
    app = await launchCanvas(root);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /^目标项目/ }).click();
    await expect
      .poll(() =>
        page
          .locator(".react-flow__node img")
          .first()
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(32);
    picker = await enter();
    await folder().click();
    const same = picker.getByRole("button", { name: "跨项目主图.png", exact: true });
    await expect(same).toHaveCount(1);
    await same.click();
    await picker.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    expect(Object.keys((await latestSnapshot(root)).assets)).toHaveLength(1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("媒体节点加入个人库：失败后重试、重复加入不移动、移出后从当前节点恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-node-library-")),
    file = join(process.cwd(), "resources/icons/icon-32.png");
  let app = await launchCanvas(root, file);
  try {
    let page = await app.firstWindow();
    await createCanvasProject(page, "节点个人库");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将icon-32.png加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const add = async () => {
      await page
        .getByRole("toolbar", { name: /的功能区$/ })
        .getByRole("button", { name: "加入资产库" })
        .click();
      return page.getByRole("dialog", { name: "加入资产库" });
    };
    let location = await add();
    await expect(location.getByRole("radio", { name: "根目录" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(location.getByRole("button", { name: "加入", exact: true })).toBeEnabled();
    await location.getByRole("button", { name: "取消" }).click();
    const db = new DatabaseSync(join(root, "personal-library/items.sqlite"), { timeout: 3000 });
    try {
      const items = () =>
        db
          .prepare(
            "SELECT id,folder FROM library_items LEFT JOIN folder_members ON item=id WHERE id NOT IN (SELECT item FROM removed_library_items)",
          )
          .all();
      expect(items()).toHaveLength(0);
      location = await add();
      await location.getByRole("button", { name: "新建文件夹" }).click();
      await location.getByLabel("新文件夹名称").fill("保留位置");
      await location.getByRole("button", { name: "创建", exact: true }).click();
      await expect(location.getByRole("radio", { name: /保留位置/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      db.exec(
        "CREATE TRIGGER fail_node_add BEFORE INSERT ON library_items BEGIN SELECT RAISE(ABORT,'test'); END",
      );
      await location.getByRole("button", { name: "加入", exact: true }).click();
      await expect(location.getByRole("alert")).toBeVisible();
      expect(items()).toHaveLength(0);
      db.exec("DROP TRIGGER fail_node_add");
      await location.getByRole("button", { name: "加入", exact: true }).click();
      await expect(page.getByText("已加入资产库", { exact: true })).toBeVisible();
      const registered = items();
      expect(registered).toHaveLength(1);
      expect(registered[0]!.folder).toBeTruthy();
      location = await add();
      await location.getByRole("button", { name: "加入", exact: true }).click();
      await expect(location).toHaveCount(0);
      expect(items()).toEqual(registered);
      await projectAction(page, "项目文件");
      await page.getByRole("button", { name: "管理个人资产库" }).click();
      const manager = page.getByRole("dialog", { name: "个人资产库管理" });
      await manager.getByRole("button", { name: "打开文件夹 保留位置" }).click();
      await manager.getByRole("button", { name: "icon-32.png 操作" }).click();
      await manager.getByRole("menuitem", { name: "移出资产库" }).click();
      await expect(manager.getByRole("status")).toHaveText("已移出资产库");
      await manager.getByRole("button", { name: "关闭个人资产库管理" }).click();
      await page.getByRole("button", { name: "关闭项目文件" }).click();
      await page.getByRole("button", { name: "资产库", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "资产库" });
      await expect(picker.getByRole("button", { name: "打开文件夹 保留位置" })).toContainText(
        "0 项",
      );
      await expect(picker.getByRole("button", { name: "icon-32.png", exact: true })).toHaveCount(0);
      await picker.getByRole("button", { name: "关闭", exact: true }).click();
      location = await add();
      await location.getByRole("button", { name: "加入", exact: true }).click();
      await expect(location).toHaveCount(0);
      expect(items()).toEqual([{ id: registered[0]!.id, folder: null }]);
      expect(Object.keys((await latestSnapshot(root)).assets)).toHaveLength(1);
    } finally {
      db.close();
    }
    await app.close();
    app = await launchCanvas(root);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /^节点个人库/ }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await page.getByRole("button", { name: "资产库", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "资产库" })
        .getByRole("button", { name: "icon-32.png", exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("个人资产库管理：重命名、搜索中移动、取消删除和删除后保留画布素材", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-library-manage-"));
  const app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page, "管理回放");
    await page.getByRole("button", { name: "资产库", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "资产库" });
    await picker
      .getByLabel("选择要上传的文件")
      .setInputFiles(join(process.cwd(), "resources/icons/icon-32.png"));
    await expect(picker.getByText("已选择 1 个素材")).toBeVisible();
    await picker.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "管理个人资产库" }).click();
    const manager = page.getByRole("dialog", { name: "个人资产库管理", exact: true });
    await expect(manager).toBeVisible();
    await manager.getByRole("button", { name: "新建文件夹" }).click();
    const create = page.getByRole("dialog", { name: "新建文件夹" });
    await create.getByLabel("文件夹名称").fill("参考");
    await create.getByRole("button", { name: "创建" }).click();
    await manager.getByRole("button", { name: "参考 操作" }).click();
    await manager.getByRole("menuitem", { name: "重命名" }).click();
    const rename = page.getByRole("dialog", { name: "重命名文件夹" });
    await expect(rename.getByLabel("文件夹名称")).toBeFocused();
    await expect(rename.getByLabel("文件夹名称")).toHaveValue("参考");
    await rename.getByLabel("文件夹名称").fill("人物");
    await rename.getByRole("button", { name: "保存" }).click();
    await expect(manager.getByRole("button", { name: "打开文件夹 人物" })).toBeVisible();
    await manager.getByLabel("搜索文件名").fill("icon");
    await expect(manager.getByRole("button", { name: "打开文件夹 人物" })).toHaveCount(0);
    const action = manager.getByRole("button", { name: "icon-32.png 操作" });
    await action.click();
    await manager.getByRole("menuitem", { name: "移动到…" }).click();
    const move = page.getByRole("dialog", { name: "移动到" });
    await expect(move.getByRole("button", { name: "移动", exact: true })).toBeDisabled();
    await move.getByRole("button", { name: "新建文件夹" }).click();
    await move.getByLabel("新文件夹名称").fill("人物");
    await move.getByRole("button", { name: "创建", exact: true }).click();
    await expect(move.getByRole("alert")).toHaveText("文件夹名称已存在");
    await move.getByLabel("新文件夹名称").fill("外景");
    await move.getByRole("button", { name: "创建", exact: true }).click();
    await expect(move.getByRole("radio", { name: /外景/ })).toHaveAttribute("aria-checked", "true");
    await move.getByRole("button", { name: "移动", exact: true }).click();
    await expect(manager.getByRole("status")).toHaveText("已移动");
    await expect(action).toBeVisible();
    await manager.getByLabel("搜索文件名").fill("");
    await expect(action).toHaveCount(0);
    await expect(manager.getByRole("button", { name: "打开文件夹 外景" })).toContainText("1 项");
    const del = async () => {
      await manager.getByRole("button", { name: "外景 操作" }).click();
      await manager.getByRole("menuitem", { name: "删除" }).click();
      return page.getByRole("alertdialog", { name: "删除文件夹「外景」？" });
    };
    let alert = await del();
    await expect(alert).toContainText("其中 1 个素材");
    await alert.getByRole("button", { name: "取消" }).click();
    await expect(manager.getByRole("button", { name: "打开文件夹 外景" })).toBeVisible();
    alert = await del();
    await alert.getByRole("button", { name: "删除" }).click();
    await expect(manager.getByRole("status")).toHaveText("已删除文件夹，移出 1 个素材");
    await manager.getByRole("button", { name: "关闭个人资产库管理" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await page.getByRole("button", { name: "资产库", exact: true }).click();
    await expect(picker.getByRole("button", { name: "打开文件夹 人物" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "icon-32.png", exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .locator(".react-flow__node img")
          .first()
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(32);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("个人资产库：另一项目删除当前文件夹后回到根目录，保留勾选并引入", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-library-stale-"));
  let app = await launchCanvas(root);
  try {
    let page = await app.firstWindow();
    const create = async (name: string) => {
      await createCanvasProject(page, name);
    };
    const enter = async () => {
      await page.getByRole("button", { name: "资产库", exact: true }).click();
      return page.getByRole("dialog", { name: "资产库" });
    };
    await create("来源");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "新建资产库文件夹" }).click();
    const name = page.getByRole("dialog", { name: "新建文件夹" });
    await name.getByLabel("文件夹名称").fill("同步");
    await name.getByRole("button", { name: "创建" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    let picker = await enter();
    await picker.getByRole("button", { name: "打开文件夹 同步" }).click();
    await picker
      .getByLabel("选择要上传的文件")
      .setInputFiles(join(process.cwd(), "resources/icons/icon-32.png"));
    await expect(picker.getByText("已选择 1 个素材")).toBeVisible();
    await picker.getByRole("button", { name: "关闭", exact: true }).click();
    await projectAction(page, "关闭项目");
    await create("目标");
    picker = await enter();
    await picker.getByRole("button", { name: "打开文件夹 同步" }).click();
    await picker.getByRole("button", { name: "icon-32.png", exact: true }).click();
    await picker.getByLabel("搜索文件名").fill("icon");
    await page.evaluate(async () => {
      const { projects } = window.desktop;
      const recent = await projects.listRecent({});
      if (!recent.ok) throw Error("recent");
      const source = recent.value.projects.find((project) => project.displayName === "来源");
      if (!source) throw Error("source");
      const opened = await projects.openRecent({ recentEntryId: source.recentEntryId });
      if (!opened.ok || opened.value.disposition !== "opened") throw Error("open");
      const { projectHandle } = opened.value.session;
      try {
        const library = await projects.listLibrary({ projectHandle });
        if (!library.ok) throw Error("list");
        const folder = library.value.folders.find((folder) => folder.name === "同步");
        if (!folder) throw Error("folder");
        const deleted = await projects.deleteLibraryFolder({ projectHandle, folderId: folder.id });
        if (!deleted.ok || deleted.value.removed !== 1) throw Error("delete");
      } finally {
        await projects.close({ projectHandle });
      }
    });
    await expect(picker.getByText("该内容已不存在")).toBeVisible();
    await expect(picker.getByLabel("搜索文件名")).toHaveValue("");
    await expect(picker.getByRole("button", { name: "icon-32.png", exact: true })).toHaveCount(0);
    await expect(picker.getByText("已选择 1 个素材")).toBeVisible();
    await expect
      .poll(() =>
        picker
          .getByLabel("已选素材")
          .locator("img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(32);
    await picker.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await app.close();
    app = await launchCanvas(root);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /^目标/ }).click();
    await expect
      .poll(() =>
        page
          .locator(".react-flow__node img")
          .first()
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(32);
    picker = await enter();
    await expect(picker.getByRole("button", { name: "icon-32.png", exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("个人资产库跨项目按勾选顺序引入音频与视频，视频封面可预览", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-library-mixed-"));
  const files = ["环境.wav", "外景.mp4"].map((name) => join(root, name));
  const ffmpeg = join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg");
  const codec =
    process.platform === "darwin"
      ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
      : ["-c:v", "libx264"];
  const app = await launchCanvas(root);
  try {
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=8000",
      "-t",
      "0.5",
      files[0]!,
    ]);
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x48",
      "-frames:v",
      "3",
      ...codec,
      files[1]!,
    ]);
    const page = await app.firstWindow();
    const create = async (name: string) => {
      await createCanvasProject(page, name);
      await page.getByRole("button", { name: "资产库", exact: true }).click();
    };
    const picker = page.getByRole("dialog", { name: "资产库" });
    await create("媒体来源");
    await picker.getByLabel("选择要上传的文件").setInputFiles(files);
    await expect(picker.getByText("已选择 2 个素材")).toBeVisible();
    const hashes = (await Promise.all(files.map((file) => readFile(file)))).map((bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );
    await picker.getByRole("button", { name: "关闭", exact: true }).click();
    await projectAction(page, "关闭项目");
    await rename(await projectDirectory(root), join(root, "已移出"));
    await Promise.all(files.map((file) => rm(file)));
    await create("媒体目标");
    const video = picker.getByRole("button", { name: "外景.mp4", exact: true });
    await expect
      .poll(() =>
        video
          .locator("..")
          .locator(".local-video-poster")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(64);
    await video.click();
    await picker.getByRole("button", { name: "环境.wav", exact: true }).click();
    await picker.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
    await expect
      .poll(async () =>
        projectCanvas((await latestSnapshot(root)).canvas).nodes.map(
          (node) => node.type === "creative" && [node.data.kind, node.data.label],
        ),
      )
      .toEqual([
        ["video", "外景"],
        ["audio", "环境"],
      ]);
    const state = await latestSnapshot(root);
    expect(
      Object.values(state.assets)
        .map((asset) => asset.sha256)
        .sort(),
    ).toEqual(hashes.sort());
    for (const hash of hashes)
      expect(
        createHash("sha256")
          .update(
            await readFile(
              join(await projectDirectory(root), "assets", "sha256", hash.slice(0, 2), hash),
            ),
          )
          .digest("hex"),
      ).toBe(hash);
    await expect(page.getByRole("button", { name: "加入资产库", exact: true })).toHaveCount(0);
    await page.locator(".react-flow__pane").click({ position: { x: 160, y: 180 } });
    for (const label of ["外景", "环境"]) {
      await page.locator(".react-flow__node header strong").filter({ hasText: label }).click();
      const strip = page.getByRole("toolbar", { name: `${label} 的功能区` }),
        audio = label === "环境";
      expect(
        await strip
          .getByRole("button")
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
      ).toEqual(
        audio
          ? ["音频修剪", "人声分离", "下载", "加入资产库"]
          : ["截取帧", "视频修剪", "放大预览", "下载", "加入资产库"],
      );
      if (audio) {
        for (const name of ["音频修剪", "人声分离"]) {
          await strip.getByRole("button", { name }).click();
          await expect(page.getByText(`「${name}」敬请期待`)).toBeVisible();
        }
        await expect(page.locator(".react-flow__node")).toHaveCount(2);
        await expect(page.locator(".react-flow__edge")).toHaveCount(0);
      }
      const downloaded = join(root, audio ? "下载.wav" : "下载.mp4");
      await app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      }, downloaded);
      await strip.getByRole("button", { name: "下载" }).click();
      await expect
        .poll(async () =>
          readFile(downloaded)
            .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
            .catch(() => null),
        )
        .toBe(
          Object.values(state.assets).find(
            (asset) => asset.mediaType === (audio ? "audio" : "video"),
          )?.sha256,
        );
      await strip.getByRole("button", { name: "加入资产库" }).click();
      const location = page.getByRole("dialog", { name: "加入资产库" });
      await location.getByRole("button", { name: "加入", exact: true }).click();
      await expect(location).toHaveCount(0);
      if (audio) {
        await projectAction(page, "所选节点属性");
        await page
          .getByRole("region", { name: "节点属性" })
          .getByRole("button", { name: "解除素材引用" })
          .click();
        await expect(strip).toHaveCount(0);
        await page.getByRole("button", { name: "关闭侧栏" }).click();
        await page.getByRole("button", { name: "撤销", exact: true }).click();
        await expect(strip.getByRole("button", { name: "下载" })).toBeEnabled();
      }
    }
    const db = new DatabaseSync(join(root, "personal-library/items.sqlite"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM library_items").get()?.count).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("资产库已选满后上传仍入库且不替换原有二十项", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-picker-upload-limit-"));
  const files = Array.from({ length: 21 }, (_, index) => join(root, `配乐${index + 1}.wav`));
  const app = await launchCanvas(root);
  try {
    const ffmpeg = join(
      process.cwd(),
      "out/media",
      `${process.platform}-${process.arch}`,
      "ffmpeg",
    );
    for (const [index, file] of files.entries())
      await runMediaProcess(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${330 + index}:sample_rate=8000`,
        "-t",
        "0.1",
        file,
      ]);
    const page = await app.firstWindow();
    await createCanvasProject(page, "已满验收");
    await page.getByRole("button", { name: "资产库", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "资产库" }),
      input = picker.getByLabel("选择要上传的文件");
    await input.setInputFiles(files.slice(0, 20));
    await expect(picker.getByText("已选择 20 个素材")).toBeVisible();
    await expect(picker.getByRole("list", { name: "已选素材" }).getByRole("button")).toHaveCount(8);
    const selected = picker.locator(".asset-pick-card[data-selected]");
    await expect(selected).toHaveCount(20);
    const selectedLabels = () =>
      selected.evaluateAll((cards) =>
        cards
          .map((card) => [
            card.querySelector("button")?.getAttribute("aria-label"),
            card.querySelector("b")?.textContent,
          ])
          .sort(([left], [right]) => (left ?? "").localeCompare(right ?? "")),
      );
    const original = await selectedLabels();
    await input.setInputFiles(files[20]!);
    await expect(
      picker.getByRole("status").filter({ hasText: "已选满，「配乐21.wav」已上传但没有勾选" }),
    ).toBeVisible();
    expect(await selectedLabels()).toEqual(original);
    await expect(picker.getByRole("button", { name: "配乐21.wav", exact: true })).toBeDisabled();
    await picker.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(20);
    await expect.poll(async () => Object.keys((await latestSnapshot(root)).assets).length).toBe(21);
    await page.getByRole("button", { name: "资产库", exact: true }).click();
    await expect(picker.getByRole("button", { name: "配乐21.wav", exact: true })).toBeEnabled();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("角色名称即时跟随标题，形象名称清空后退出重开不回填", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-character-identity-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "身份字段验收");
    await addCanvasNode(page, "角色卡");
    const card = page.locator(".creative-card[data-character]");
    const open = () => card.locator(".character-cover").dblclick({ position: { x: 45, y: 45 } });
    const dialog = page.getByRole("dialog", { name: "角色卡" });
    const name = dialog.getByLabel("角色名称", { exact: true });
    const look = dialog.getByLabel("形象名称", { exact: true });
    const persisted = async () => {
      const node = projectCanvas((await latestSnapshot(root)).canvas).nodes[0];
      return (
        node?.type === "creative" && [
          node.data.label,
          node.data.character?.name,
          node.data.character?.look,
        ]
      );
    };
    await open();
    await expect(name).toHaveAttribute("maxlength", "64");
    await expect(look).toHaveAttribute("maxlength", "64");
    await name.fill("  林舟  ");
    await name.press("Enter");
    await expect(name).toHaveValue("  林舟  ");
    await look.fill("  夜班  ");
    await expect.poll(persisted).toEqual(["林舟", "林舟", "  夜班  "]);
    await name.fill("   ");
    await name.press("Tab");
    await expect(name).toHaveValue("林舟");
    await expect(look).toBeFocused();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(persisted).toEqual(["未命名角色", "未命名角色", "基础形象"]);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(persisted).toEqual(["林舟", "林舟", "  夜班  "]);
    await card.getByText("林舟", { exact: true }).dblclick();
    const title = card.getByRole("textbox", { name: "节点名称" });
    await title.fill("自定义");
    await title.press("Enter");
    await open();
    await expect(look).toHaveValue("  夜班  ");
    await name.fill("林宁");
    await look.fill("");
    const bounds = await dialog.boundingBox();
    if (!bounds) throw new Error("角色详情没有显示");
    await page.mouse.click(bounds.x - 5, bounds.y + 10);
    await expect(dialog).toHaveCount(0);
    await expect.poll(persisted).toEqual(["自定义", "林宁", ""]);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^身份字段验收/ }).click();
    await reopened.locator(".character-cover").dblclick({ position: { x: 45, y: 45 } });
    await expect(reopened.getByLabel("角色名称", { exact: true })).toHaveValue("林宁");
    await expect(reopened.getByLabel("形象名称", { exact: true })).toHaveValue("");
    const capture = test.info().outputPath("character-details-restored.png");
    await reopened.screenshot({ path: capture });
    await test.info().attach("重开后的角色详情整窗", { contentType: "image/png", path: capture });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("角色声音上传校验、来源和音色描述跨重启保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-voice-upload-"));
  const file = join(root, "试音.wav");
  let application = await launchCanvas(root);
  try {
    const ffmpeg = join(
      process.cwd(),
      "out/media",
      `${process.platform}-${process.arch}`,
      "ffmpeg",
    );
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=8000",
      "-t",
      "1",
      file,
    ]);
    const page = await application.firstWindow();
    await createCanvasProject(page, "上传声音验收");
    await addCanvasNode(page, "角色卡");
    await page.getByRole("button", { name: "声音：打开详情设置" }).click();
    const panel = page.getByRole("dialog", { name: "角色卡" });
    const choose = async (path: string) => {
      const picking = page.waitForEvent("filechooser");
      await panel.getByRole("button", { name: "上传声音" }).click();
      const chooser = await picking;
      expect(chooser.isMultiple()).toBe(false);
      expect(await chooser.element().getAttribute("accept")).toBe(
        "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.flac,.opus",
      );
      await chooser.setFiles(path);
    };
    await choose(join(process.cwd(), "resources/icons/icon-32.png"));
    await expect(panel.getByRole("alert")).toHaveText("音色只能上传音频");
    await choose(file);
    await expect(panel.locator(".voice-origin")).toHaveText("上传");
    const assetId = await panel.locator(".voice-current-row").getAttribute("data-asset-id");
    await panel.getByLabel("AI 生成", { exact: true }).fill("  低音\n你好。  ");
    await panel.getByRole("button", { name: "试听", exact: true }).click();
    await expect(panel.getByRole("button", { name: "暂停", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "暂停试听" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "试听声音" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect
      .poll(async () => {
        const node = projectCanvas((await latestSnapshot(root)).canvas).nodes[0];
        return node?.type === "creative" && node.data.character;
      })
      .toMatchObject({
        voice: { assetId, origin: "upload", name: "试音.wav" },
        voicePrompt: "  低音\n你好。  ",
      });
    expect(Object.keys((await latestSnapshot(root)).assets)).toHaveLength(1);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^上传声音验收/ }).click();
    await reopened.locator(".character-cover").dblclick({ position: { x: 45, y: 45 } });
    await expect(reopened.getByLabel("AI 生成", { exact: true })).toHaveValue("  低音\n你好。  ");
    await expect(reopened.locator(".voice-current-row")).toHaveAttribute("data-asset-id", assetId!);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("角色卡绑定主图并持久保存造型和角色设定", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-character-e2e-"));
  const image = join(root, "look.png");
  await writeFile(
    image,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  let application = await launchCanvas(root, image);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "角色卡验收");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await expect(page.getByRole("button", { name: "将look.png加入画布" })).toBeVisible();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await addCanvasNode(page, "角色卡");
    const character = page.getByRole("dialog", { name: "角色卡" });
    const card = page.locator(".creative-card[data-character]");
    await expect(character).toHaveCount(0);
    await expect(card.getByText("待补充")).toBeVisible();
    await card.getByRole("button", { name: "添加补充图" }).click();
    const extrasPicker = page.getByRole("dialog", { name: "选择补充图" });
    await extrasPicker.getByRole("button", { name: "look.png", exact: true }).click();
    await expect(card.locator(".character-media-row img")).toHaveCount(0);
    await extrasPicker.getByRole("button", { name: "确定" }).click();
    await expect(card.locator(".character-media-row img")).toHaveCount(1);
    await expect(card.locator(".character-cover img")).toHaveCount(0);
    await expect
      .poll(async () => {
        const node = projectCanvas((await latestSnapshot(root)).canvas).nodes[0];
        return node?.type === "creative" ? node.data.character?.extraAssetIds.length : undefined;
      })
      .toBe(1);
    await card.getByText("未命名角色", { exact: true }).dblclick();
    await expect(card.getByRole("textbox", { name: "节点名称" })).toBeFocused();
    await card.getByRole("textbox", { name: "节点名称" }).fill("自定义标题");
    await page.keyboard.press("Enter");
    await card.locator(".character-cover").dblclick({ position: { x: 45, y: 45 } });
    await character.getByLabel("角色名").fill("林舟");
    await character.getByLabel("形象名").fill("夜班");
    await expect(character.getByLabel("角色设定")).toHaveCount(0);
    await expect(character.getByRole("button", { name: "从资产库选补充图" })).toBeDisabled();
    await character.getByRole("button", { name: "从资产库选主图", exact: true }).click();
    const mainPicker = page.getByRole("dialog", { name: "选择形象主图" });
    await mainPicker.getByRole("button", { name: "look.png", exact: true }).click();
    await mainPicker.getByRole("button", { name: "确定" }).click();
    await expect(character.getByLabel("主图", { exact: true })).toHaveText("look.png");
    await character.getByRole("button", { name: "从资产库选补充图" }).click();
    await expect(
      extrasPicker.getByRole("button", { name: "look.png", exact: true }),
    ).toBeDisabled();
    await expect(extrasPicker.getByText("已是主图")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(character.getByLabel("角色名")).toHaveValue("林舟");
    await character.getByRole("button", { name: "关闭角色卡" }).click();
    await expect(card.locator(".character-media-row img")).toHaveCount(0);
    await expect(page.locator(".react-flow__node img")).toHaveCount(1);
    await card.locator(".character-cover").click();
    await expect(page.getByRole("region", { name: "生成确认" })).toHaveCount(0);
    await projectAction(page, "所选节点属性");
    await page.getByLabel("角色设定").fill("车站的夜班值班员");
    await page.getByRole("button", { name: "关闭侧栏" }).click();
    await expect
      .poll(async () => (await latestSnapshot(root)).canvas.nodes)
      .toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            character: {
              name: "林舟",
              look: "夜班",
              description: "车站的夜班值班员",
              extraAssetIds: [],
            },
          }),
        }),
      ]);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^角色卡验收/ }).click();
    await expect(reopened.getByText("自定义标题", { exact: true })).toBeVisible();
    await reopened.getByRole("img", { name: "林舟", exact: true }).dblclick();
    const restored = reopened.getByRole("dialog", { name: "角色卡" });
    await expect(restored.getByLabel("角色设定")).toHaveCount(0);
    await expect(restored.getByLabel("主图", { exact: true })).toHaveText("look.png");
    const emptySlots = restored.getByRole("button", { name: "上传补充图" });
    await expect(emptySlots).toHaveCount(4);
    await expect(emptySlots.nth(1)).toBeDisabled();
    const choosing = reopened.waitForEvent("filechooser");
    await emptySlots.first().click();
    const chooser = await choosing;
    expect(chooser.isMultiple()).toBe(false);
    expect(await chooser.element().getAttribute("accept")).toBe("image/*");
    await chooser.setFiles(join(process.cwd(), "resources/icons/icon-32.png"));
    const zoomExtra = restored.getByRole("button", { name: "放大预览补充图 1" });
    await expect(zoomExtra.locator("img")).toHaveJSProperty("naturalWidth", 32);
    await zoomExtra.click();
    const lightbox = reopened.getByRole("dialog", { name: "媒体预览" });
    await expect(lightbox.getByText(/^32×32 · /)).toBeVisible();
    await reopened.keyboard.press("ArrowLeft");
    await expect(lightbox.getByText(/^3×2 · /)).toBeVisible();
    await reopened.keyboard.press("Escape");
    await expect(zoomExtra).toBeFocused();
    await zoomExtra.hover();
    await restored.getByRole("button", { name: "移除补充图", exact: true }).click();
    await expect(emptySlots).toHaveCount(4);
    await reopened.keyboard.press("Escape");
    await expect
      .poll(async () => {
        const node = projectCanvas((await latestSnapshot(root)).canvas).nodes[0];
        return node?.type === "creative" ? node.data.character?.extraAssetIds : undefined;
      })
      .toEqual([]);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const fixture of [
  {
    kind: "image",
    name: "图片",
    menu: "图片生成",
    adapter: "openai-image",
    model: "gpt-image-1",
    path: "/v1/images/generations",
  },
  {
    kind: "video",
    name: "视频",
    menu: "视频生成",
    adapter: "agnes-video",
    model: "agnes-video-2.5-flash",
    path: "/v1/videos",
  },
  {
    kind: "audio",
    name: "音频",
    menu: "音频",
    adapter: "doubao-audio",
    model: "seed-audio-1.0",
    path: "/api/v3/tts/create",
  },
] as const)
  test(`普通${fixture.name}节点同步显示任务，重开后用当前提示词从卡面重试`, async () => {
    test.setTimeout(60_000);
    const root = await mkdtemp(join(tmpdir(), "link-media-card-retry-"));
    const prompts: string[] = [];
    let finish: (() => void) | undefined;
    let completeTransfer: (() => void) | undefined;
    let endpoint = "";
    let videoReady = false;
    const mediaPath = fixture.kind === "audio" ? "/fixture.wav" : "/fixture.mp4";
    const server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === mediaPath) {
        const bytes = await readFile(join(root, mediaPath.slice(1)));
        completeTransfer = () =>
          response
            .writeHead(200, {
              "content-type": fixture.kind === "video" ? "video/mp4" : "audio/wav",
            })
            .end(bytes);
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/agnesapi?")) {
        response.end(
          JSON.stringify(
            videoReady
              ? { status: "completed", url: endpoint + mediaPath }
              : { status: "running", progress: 37 },
          ),
        );
        return;
      }
      if (request.url !== fixture.path || request.method !== "POST")
        return void response.writeHead(404).end();
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      prompts.push(fixture.kind === "audio" ? body.text_prompt : body.prompt);
      finish =
        prompts.length === 1 || prompts.at(-1) === "失败后恢复旧版"
          ? () =>
              response
                .writeHead(400)
                .end(JSON.stringify({ error: { message: "fixture rejected" } }))
          : fixture.kind === "video"
            ? () => response.end(JSON.stringify({ video_id: "fixture-video" }))
            : fixture.kind === "audio"
              ? () => response.end(JSON.stringify({ code: 0, url: endpoint + mediaPath }))
              : () =>
                  response.end(
                    JSON.stringify({
                      data: [
                        {
                          b64_json:
                            "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=",
                        },
                      ],
                    }),
                  );
    });
    const app = await launchCanvas(root);
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing endpoint");
      endpoint = `http://127.0.0.1:${address.port}`;
      if (fixture.kind !== "image") {
        const input =
          fixture.kind === "audio"
            ? ["sine=frequency=440:sample_rate=16000", "-c:a", "pcm_s16le"]
            : [
                "testsrc2=s=160x90:r=12",
                ...(process.platform === "darwin"
                  ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
                  : ["-c:v", "libx264"]),
              ];
        await runMediaProcess(
          join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg"),
          ["-v", "error", "-f", "lavfi", "-i", ...input, "-t", "3", join(root, mediaPath.slice(1))],
        );
      }
      const page = await app.firstWindow();
      await page.evaluate(
        async ({ endpoint, fixture }) => {
          const list = await window.desktop.settings.list({});
          if (!list.ok) throw new Error(list.code);
          const plugin = list.value.plugins.find((item) => item.key === fixture.adapter)!;
          const saved = await window.desktop.settings.save({
            expectedRevision: 0,
            pluginHash: plugin.hash,
            approve: true,
            secret: "fixture-key",
            fields: {
              label: `测试${fixture.name}`,
              model: fixture.model,
              endpoint,
              allowLocal: true,
              agentEnabled: false,
              channel: {},
            },
          });
          if (!saved.ok) throw new Error(saved.code);
        },
        { endpoint, fixture },
      );
      await createCanvasProject(page, "媒体失败回放");
      await addCanvasNode(page, fixture.menu);
      const card = page.locator(`article[data-card-kind="${fixture.kind}"]`);
      const renderedImage = card.locator('.node-media img[src^="link-media:"]');
      const heading = card.locator("header");
      await card.click({ position: { x: 30, y: 30 } });
      const prompt = page.getByRole("textbox", { name: "生成提示词" });
      await prompt.fill("雨中的车站");
      await page.getByRole("button", { name: "开始生成" }).click();
      await expect.poll(() => prompts).toEqual(["雨中的车站"]);
      await expect(heading).toContainText("生成中");
      await expect(card.getByRole("status")).toContainText("已耗时");
      await expect(card.getByRole("button", { name: "取消" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "生成任务中心" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "生成中", exact: true })).toBeDisabled();
      await prompt.fill("正在编辑的下一稿");
      await prompt.press("Enter");
      finish?.();
      await expect(heading).toContainText("生成失败");
      await expect(prompt).toHaveText("正在编辑的下一稿");
      await expect(card.getByRole("alert")).toBeVisible();
      const copy = card.getByRole("button", { name: /任务 ID/ });
      const original = await copy.getAttribute("aria-label");
      await prompt.fill("");
      await expect(card.getByRole("button", { name: "重试" })).toBeDisabled();
      await expect(card.locator(".task-retry")).toHaveAttribute("title", "请先填写提示词。");
      await prompt.fill("晴天的车站");
      expect(prompts).toEqual(["雨中的车站"]);
      await projectAction(page, "关闭项目");
      await page.getByRole("button", { name: /^媒体失败回放/ }).click();
      await expect(copy).toHaveAttribute("aria-label", original!);
      await copy.click();
      await expect(copy).toHaveText("已复制任务 ID");
      await page.locator(".react-flow__pane").click({ position: { x: 65, y: 90 } });
      await expect(prompt).toHaveCount(0);
      await card.getByRole("button", { name: "重试" }).click();
      await expect.poll(() => prompts).toEqual(["雨中的车站", "晴天的车站"]);
      const mountedForm = await prompt.locator("xpath=ancestor::form").elementHandle();
      await expect(heading).toContainText("生成中");
      await expect(card.getByRole("status")).toContainText("生成中");
      const savedNode = async () =>
        projectCanvas((await latestSnapshot(root)).canvas).nodes.find(
          (node) => node.type === "creative",
        );
      await prompt.fill("下次使用的第三稿");
      await expect.poll(async () => (await savedNode())?.data.text).toBe("下次使用的第三稿");
      finish?.();
      if (fixture.kind === "image") await expect(renderedImage).toHaveCSS("opacity", "1");
      else {
        if (fixture.kind === "video") {
          await expect(heading).toContainText("生成中 37%", { timeout: 15_000 });
          await expect(card.getByRole("status")).toContainText("37%");
          videoReady = true;
        }
        await expect.poll(() => !!completeTransfer, { timeout: 15_000 }).toBe(true);
        await expect(heading).toContainText("即将完成");
        await expect(card.getByRole("status")).toContainText(`正在保存${fixture.name}`);
        await expect(card.getByRole("button", { name: "取消" })).toHaveCount(0);
        completeTransfer?.();
        const play = card.getByRole("button", {
          name: fixture.kind === "video" ? "播放视频" : "播放",
          exact: true,
        });
        await expect(play).toBeVisible();
        await projectAction(page, "关闭项目");
        await page.getByRole("button", { name: /^媒体失败回放/ }).click();
        await play.click();
        await expect
          .poll(() =>
            card
              .locator(fixture.kind)
              .evaluate(
                (el: HTMLMediaElement) => !el.paused && el.currentTime > 0 && el.duration >= 2.9,
              ),
          )
          .toBe(true);
        expect(prompts).toEqual(["雨中的车站", "晴天的车站"]);
      }
      await expect(heading.locator(".canvas-task-label")).toHaveCount(0);
      await expect
        .poll(async () => (await savedNode())?.data)
        .toMatchObject({
          text: "下次使用的第三稿",
          activeOutputId: expect.any(String),
          assetId: expect.any(String),
        });
      await expect.poll(async () => Object.keys((await latestSnapshot(root)).jobs).length).toBe(2);
      if (fixture.kind === "image") {
        const cycle: {
          step: string;
          phase: string;
          prompt: string;
          versions: number;
          adopted: number;
        }[] = [];
        const capture = async (step: string) => {
          const data = (await savedNode())!.data;
          const phase = (await card.getByRole("alert").count())
            ? "failed"
            : (await card.getByRole("status").count())
              ? "running"
              : (await card.locator(".node-media img").count())
                ? "done"
                : "idle";
          cycle.push({
            step,
            phase,
            prompt: data.text,
            versions: data.outputs?.length ?? 0,
            adopted:
              data.outputs?.findIndex(
                (output) => output.id === data.activeOutputId && output.assetId === data.assetId,
              ) ?? -1,
          });
        };
        const adopted = (await savedNode())!.data.activeOutputId;
        await prompt.fill("晴天的车站");
        await expect
          .poll(async () => (await savedNode())?.data)
          .toMatchObject({ text: "晴天的车站", activeOutputId: adopted });
        expect(await mountedForm?.evaluate((form) => form.isConnected)).toBe(true);
        await page.getByRole("button", { name: "开始生成" }).click();
        await expect.poll(() => prompts).toEqual(["雨中的车站", "晴天的车站", "晴天的车站"]);
        finish?.();
        await expect.poll(async () => (await savedNode())?.data.outputs?.length).toBe(2);
        expect((await savedNode())?.data.activeOutputId).not.toBe(adopted);
        await expect(renderedImage).toHaveCSS("opacity", "1");
        const previousVersion = (await savedNode())!.data.activeOutputId!;
        await capture("two-results");
        const versionDialog = page.getByRole("dialog", { name: "历史记录", exact: true });
        const badge = card.getByRole("button", { name: /历史记录，共/ });
        await expect(badge).toHaveAccessibleName("历史记录，共 2 版");
        await badge.click();
        await versionDialog.getByRole("button", { name: "全屏查看" }).click();
        const fullHistory = page.getByRole("dialog", { name: "全屏查看" });
        const latestTile = fullHistory.getByRole("button", {
          name: "第 2 版（当前主图）",
          exact: true,
        });
        await latestTile.focus();
        await latestTile.press("ArrowRight");
        const firstTile = fullHistory.getByRole("button", { name: "第 1 版", exact: true });
        await expect(firstTile).toBeFocused();
        await firstTile.getByRole("button", { name: "放大" }).click();
        const lightbox = page.getByRole("dialog", { name: "媒体预览" });
        await expect(lightbox.getByRole("button", { name: "设为主图" })).toBeEnabled();
        await page.keyboard.press("Escape");
        await expect(lightbox).toHaveCount(0);
        await expect(fullHistory).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(fullHistory).toHaveCount(0);
        await expect(versionDialog).toBeVisible();
        await versionDialog.getByRole("button", { name: "更多" }).click();
        await expect(page.getByRole("menuitem", { name: "取消剩余" })).toBeDisabled();
        await page.keyboard.press("Escape");
        const versionFile = test.info().outputPath("version-one.png");
        await app.evaluate(({ BrowserWindow }, path) => {
          BrowserWindow.getAllWindows()[0]!.webContents.session.once(
            "will-download",
            (_event, item) => item.setSavePath(path),
          );
        }, versionFile);
        const oldest = versionDialog.getByRole("button", { name: "第 1 版", exact: true });
        await oldest.hover();
        await oldest.getByRole("button", { name: "下载", exact: true }).click();
        await expect
          .poll(() =>
            readFile(versionFile).then(
              (bytes) => bytes.toString("base64"),
              () => null,
            ),
          )
          .toBe(
            "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=",
          );
        await versionDialog.getByRole("button", { name: "关闭", exact: true }).click();
        await prompt.fill("失败后恢复旧版");
        await page.getByRole("button", { name: "开始生成" }).click();
        await expect.poll(() => prompts.at(-1)).toBe("失败后恢复旧版");
        await expect.poll(async () => (await savedNode())?.data.assetId).toBeUndefined();
        await expect(heading).toContainText("生成中");
        await capture("regenerate");
        await page.getByRole("button", { name: "撤销", exact: true }).click();
        await expect.poll(async () => (await savedNode())?.data.text).toBe("晴天的车站");
        await expect(card.getByRole("status")).toBeVisible();
        await capture("undo-draft");
        await page.getByRole("button", { name: "重做", exact: true }).click();
        await expect.poll(async () => (await savedNode())?.data.text).toBe("失败后恢复旧版");
        await capture("redo-draft");
        await expect(badge).toHaveAccessibleName("历史记录，共 3 版，还有任务在生成");
        await badge.click();
        const priorTile = versionDialog.getByRole("button", { name: "第 2 版", exact: true });
        await expect(priorTile).toHaveAttribute("title", "生成中，出第一张后可切换");
        await priorTile.click();
        await expect(priorTile).toHaveAttribute("aria-pressed", "false");
        await versionDialog.getByRole("button", { name: "关闭", exact: true }).click();
        finish?.();
        await expect(card.getByRole("button", { name: "重试" })).toBeEnabled();
        await expect(card.locator(".node-media img")).toHaveCount(0);
        await capture("failure");
        await projectAction(page, "关闭项目");
        await page.getByRole("button", { name: /^媒体失败回放/ }).click();
        await expect(heading).toContainText("生成失败");
        await capture("reopened-failure");
        await badge.click();
        await priorTile.press("Enter");
        await expect(
          versionDialog.getByRole("button", { name: "第 2 版（当前主图）", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
        await versionDialog.getByRole("button", { name: "关闭", exact: true }).click();
        await expect(renderedImage).toHaveCSS("opacity", "1");
        await expect
          .poll(async () => (await savedNode())?.data.activeOutputId)
          .toBe(previousVersion);
        await capture("choose-prior");
        await projectAction(page, "关闭项目");
        await page.getByRole("button", { name: /^媒体失败回放/ }).click();
        await expect(renderedImage).toHaveCSS("opacity", "1");
        await expect(card.getByRole("alert")).toHaveCount(0);
        expect(prompts.length).toBe(4);
        await capture("reopened-choice");
        await badge.click();
        await versionDialog.getByRole("button", { name: "更多" }).click();
        await page.getByRole("menuitem", { name: "全部添加到画布" }).click();
        await versionDialog.getByRole("button", { name: "关闭", exact: true }).click();
        const splitVersions = async () =>
          projectCanvas((await latestSnapshot(root)).canvas).nodes.filter(
            (node) => node.type === "creative" && node.data.label.includes(" · 版本"),
          );
        await expect
          .poll(async () =>
            (await splitVersions()).map(
              (node) =>
                node.type === "creative" && [
                  node.data.text,
                  node.data.outputs?.length,
                  node.data.outputs?.[0]?.id === node.data.activeOutputId,
                ],
            ),
          )
          .toEqual([
            ["", 1, true],
            ["", 1, true],
          ]);
        const beforeUndo = await splitVersions();
        await page.getByRole("button", { name: "撤销", exact: true }).click();
        await expect.poll(splitVersions).toEqual([]);
        await page.getByRole("button", { name: "重做", exact: true }).click();
        await expect.poll(splitVersions).toEqual(beforeUndo);
        expect(prompts.length).toBe(4);
        await writeFile(
          test.info().outputPath("media-version-cycle.json"),
          JSON.stringify(cycle, null, 2),
        );
      }
    } finally {
      await app.close();
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("角色形象封面显示生成状态，重开后从失败卡面直接重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-character-retry-"));
  const requests: unknown[] = [];
  let finish: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/images/generations") return void response.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    finish =
      requests.length === 1
        ? () =>
            response.writeHead(400).end(JSON.stringify({ error: { message: "fixture rejected" } }))
        : () =>
            response.end(
              JSON.stringify({
                data: [
                  {
                    b64_json:
                      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=",
                  },
                ],
              }),
            );
  });
  let application = await launchCanvas(root);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture endpoint");
    let page = await application.firstWindow();
    await page.setViewportSize(compactViewport);
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      if (!list.ok) throw new Error(list.code);
      const plugin = list.value.plugins.find((item) => item.key === "openai-image");
      if (!plugin) throw new Error("Missing image adapter");
      const saved = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-key",
        fields: {
          label: "角色重试",
          model: "gpt-image-1",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!saved.ok) throw new Error(saved.code);
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page, "形象重试");
    await addCanvasNode(page, "角色卡");
    await page.getByRole("textbox", { name: "生成提示词" }).fill("夜班的车站管理员");
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    let cover = page.locator(".character-cover");
    await expect(cover.getByRole("status")).toContainText("已耗时");
    await expect(cover.getByRole("button", { name: "上传" })).toHaveCount(0);
    finish?.();
    await expect(cover.getByRole("alert")).toBeVisible();
    const identifier = await cover
      .getByRole("button", { name: /任务 ID/ })
      .getAttribute("aria-label");
    await application.close();
    application = await launchCanvas(root);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /^形象重试/ }).click();
    cover = page.locator(".character-cover");
    const copy = cover.getByRole("button", { name: /任务 ID/ });
    await expect(copy).toHaveAttribute("aria-label", identifier!);
    await copy.click();
    await expect(copy).toHaveText("已复制任务 ID");
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      identifier?.match(/^任务 ID (.+)，点击复制$/)?.[1],
    );
    await cover.getByRole("button", { name: "重试" }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(cover.getByRole("status")).toContainText("生成中");
    finish?.();
    await expect(cover.getByRole("img", { name: "未命名角色" })).toBeVisible();
    await expect(page.locator(".character-look-row")).not.toContainText("生成失败");
    await expect.poll(async () => Object.keys((await latestSnapshot(root)).jobs).length).toBe(2);
  } finally {
    await application.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("角色形象与音色联合生成，音色可独立重试、自动绑定和试听", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-character-voice-"));
  const audio = Buffer.from(
    "T2dnUwACAAAAAAAAAACgCKTfAAAAAGIERBUBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAKAIpN8BAAAAvcMZTQE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAyAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMiBsaWJvcHVzT2dnUwAEOBAAAAAAAACgCKTfAgAAAJcZJUsFAwMDAwP4//74//74//74//74//4=",
    "base64",
  );
  let endpoint = "";
  const prompts: string[] = [];
  const references: unknown[] = [];
  const imageBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=";
  let imageResult: (() => void) | undefined;
  let imageCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/voice.ogg") {
      response.writeHead(200, { "content-type": "application/ogg" }).end(audio);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/images/generations") {
      request.resume();
      imageCalls++;
      imageResult = () => response.end(JSON.stringify({ data: [{ b64_json: imageBase64 }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/v3/tts/create") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    prompts.push(body.text_prompt);
    references.push(body.references);
    if (prompts.length === 1) {
      response.writeHead(400).end(JSON.stringify({ code: 400, message: "fixture rejected" }));
      return;
    }
    response.end(JSON.stringify({ code: 0, url: `${endpoint}/voice.ogg` }));
  });
  let application: Awaited<ReturnType<typeof launchCanvas>> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test endpoint");
    endpoint = `http://127.0.0.1:${address.port}`;
    application = await launchCanvas(root);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      if (!list.ok) throw new Error(list.code);
      const plugin = list.value.plugins.find(({ key }) => key === "doubao-audio");
      if (!plugin) throw new Error("Missing audio adapter");
      const result = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-audio-key",
        fields: {
          label: "角色音色测试",
          model: "seed-audio-1.0",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: { as: "base64" },
        },
      });
      if (!result.ok) throw new Error(result.code);
      const imagePlugin = list.value.plugins.find(({ key }) => key === "openai-image");
      if (!imagePlugin) throw new Error("Missing image adapter");
      const alternate = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-alt-key",
        fields: {
          label: "备用音频渠道",
          model: "seed-audio-alt",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: { as: "base64" },
        },
      });
      if (!alternate.ok) throw new Error(alternate.code);
      const imageModel = await settings.save({
        expectedRevision: 0,
        pluginHash: imagePlugin.hash,
        approve: true,
        secret: "fixture-image-key",
        fields: {
          label: "角色形象测试",
          model: "gpt-image-1",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!imageModel.ok) throw new Error(imageModel.code);
    }, endpoint);
    await createCanvasProject(page, "音色验收");
    await addCanvasNode(page, "角色卡");
    const dialog = page.getByRole("dialog", { name: "角色卡" });
    await page.getByRole("button", { name: "声音：打开详情设置" }).click();
    await dialog.getByLabel("角色名").fill("林舟");
    await dialog.getByLabel("形象名").fill("夜班");
    const modelMenu = dialog.getByRole("button", { name: "选择模型" });
    await modelMenu.click();
    await expect(dialog.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("menu")).toHaveCount(0);
    await expect(modelMenu).toBeFocused();
    await modelMenu.click();
    await dialog.getByRole("menuitemradio", { name: /备用音频渠道/ }).click();
    await expect(modelMenu).toHaveText("seed-audio-alt");
    await modelMenu.click();
    await dialog.getByRole("menuitemradio", { name: /角色音色测试/ }).click();
    await expect(modelMenu).toHaveText("seed-audio-1.0");
    await dialog.getByRole("button", { name: "生成声音" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("还没有音色描述");
    await dialog.getByLabel("AI 生成", { exact: true }).fill("夜班列车即将进站。");
    await dialog.getByRole("button", { name: "关闭角色卡" }).click();
    await page.getByRole("textbox", { name: "生成提示词" }).fill("夜班值班员的角色设计");
    await page.getByRole("button", { name: "含音色", exact: true }).click();
    await page.getByRole("button", { name: "编辑角色卡" }).click();
    await expect(
      dialog.getByRole("list", { name: "历史版本" }).getByRole("listitem").first(),
    ).toContainText("生成中");
    await expect.poll(() => imageCalls).toBe(1);
    expect(prompts).toEqual([]);
    imageResult?.();
    await expect(dialog.getByRole("button", { name: "重试", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.getByLabel("主图", { exact: true })).toHaveAttribute("data-asset-id", /.+/);
    const history = dialog.getByRole("list", { name: "历史版本" });
    await expect(history.getByRole("listitem")).toHaveCount(1);
    await expect(history.getByText("夜班列车即将进站。")).toBeVisible();
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await expect(history.getByText("当前", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(prompts).toEqual(["夜班列车即将进站。", "夜班列车即将进站。"]);
    expect(references).toEqual([[{ image_data: imageBase64 }], [{ image_data: imageBase64 }]]);
    expect(imageCalls).toBe(1);
    await expect(dialog.locator(".voice-origin")).toHaveText("AI 生成");
    await expect(dialog.getByLabel("角色名")).toHaveValue("林舟");
    await expect(dialog.getByLabel("形象名")).toHaveValue("夜班");
    await history.getByRole("button", { name: "试听" }).click();
    await expect(page.getByRole("dialog", { name: /^生成-/ })).toHaveCount(0);
    await expect(history.getByRole("listitem").first()).toContainText("当前");
    const adopted = await dialog.locator(".voice-current-row").getAttribute("data-asset-id");
    if (!adopted) throw Error("缺少当前音色素材");
    const adoptedName = (await latestSnapshot(root)).assets[adopted]?.displayName;
    expect(adoptedName).toMatch(/^生成-.+\.ogg$/);
    await modelMenu.click();
    await dialog.getByRole("menuitemradio", { name: /备用音频渠道/ }).click();
    await dialog.getByRole("button", { name: "关闭角色卡" }).click();
    await expect
      .poll(async () => (await latestSnapshot(root)).canvas.nodes)
      .toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            character: expect.objectContaining({
              voice: expect.objectContaining({ assetId: adopted, origin: "generated" }),
            }),
          }),
        }),
      ]);
    await projectAction(page, "生成任务");
    const voiceTask = page
      .locator(".job-row")
      .filter({ hasText: "角色音色" })
      .filter({ hasText: "已完成" });
    await expect(voiceTask).toBeVisible();
    await expect(voiceTask).not.toContainText("试听后，可在角色卡中采用此音色。");
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^音色验收/ }).click();
    await expect(
      reopened.locator(".creative-card header").getByText("林舟", { exact: true }),
    ).toBeVisible();
    await reopened.getByRole("button", { name: "编辑角色卡", exact: true }).click();
    const restored = reopened.getByRole("dialog", { name: "角色卡" });
    await expect(restored.locator(".voice-current-row")).toHaveAttribute("data-asset-id", adopted!);
    await expect(restored.getByRole("button", { name: "选择模型" })).toHaveText("seed-audio-alt");
    await expect(restored.getByText("当前", { exact: true })).toBeVisible();
    await restored.getByRole("button", { name: "绑定已有", exact: true }).click();
    const voicePicker = reopened.getByRole("dialog", { name: "选择音色音频" });
    await expect(voicePicker.getByRole("tab", { name: "真人库" })).toHaveCount(0);
    await voicePicker.getByRole("tab", { name: "生成历史" }).click();
    const candidates = voicePicker.locator(".asset-pick-card");
    await expect(candidates).toHaveCount(1);
    await expect(candidates).toHaveAttribute("data-kind", "audio");
    await candidates.getByRole("button").click();
    await voicePicker.getByRole("button", { name: "确定" }).click();
    await expect(restored.locator(".voice-origin")).toHaveText("资产库");
    await restored.getByRole("button", { name: "关闭角色卡" }).click();
    await expect
      .poll(async () =>
        projectCanvas((await latestSnapshot(root)).canvas).nodes.flatMap((node) =>
          node.type === "creative" ? [node.data.character?.voice] : [],
        ),
      )
      .toEqual([{ assetId: adopted, origin: "library", name: adoptedName }]);
    await reopened.getByRole("button", { name: "编辑角色卡", exact: true }).click();
    const alternateFile = join(root, "备用配音.wav");
    await runMediaProcess(
      join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg"),
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=380:sample_rate=8000",
        "-t",
        "1",
        alternateFile,
      ],
    );
    const picking = reopened.waitForEvent("filechooser");
    await restored.getByRole("button", { name: "上传声音" }).click();
    await (await picking).setFiles(alternateFile);
    await expect(restored.locator(".voice-origin")).toHaveText("上传");
    await restored.getByRole("button", { name: "设为音色" }).click();
    await expect(restored.locator(".voice-origin")).toHaveText("AI 生成");
    await reopened.keyboard.press("Escape");
    await expect
      .poll(async () =>
        projectCanvas((await latestSnapshot(root)).canvas).nodes.flatMap((node) =>
          node.type === "creative" ? [node.data.character?.voice] : [],
        ),
      )
      .toEqual([{ assetId: adopted, origin: "generated", name: adoptedName }]);
    await reopened.locator(".character-cover").click({ position: { x: 45, y: 45 } });
    await reopened.getByRole("textbox", { name: "生成提示词" }).fill("备用配音的形象");
    const combined = reopened.getByRole("button", { name: "含音色", exact: true });
    await expect(combined).toBeEnabled();
    await combined.click();
    await reopened.getByRole("button", { name: "编辑角色卡", exact: true }).click();
    const versions = restored.getByRole("list", { name: "历史版本" });
    await expect(versions.getByRole("listitem").first()).toContainText("生成中");
    await restored
      .getByRole("region", { name: "声音", exact: true })
      .getByRole("button", { name: /取消$/ })
      .click();
    await expect(versions.getByRole("listitem").first()).toContainText("已取消");
    expect(prompts).toHaveLength(2);
    await expect.poll(() => imageCalls).toBe(2);
    imageResult?.();
    await expect
      .poll(
        async () =>
          Object.values((await latestSnapshot(root)).jobs).filter(
            (job) =>
              job &&
              typeof job === "object" &&
              !Array.isArray(job) &&
              job.kind === "image" &&
              job.status === "succeeded",
          ).length,
      )
      .toBe(2);
    expect(prompts).toHaveLength(2);
    await expect(restored.locator(".voice-current-row")).toHaveAttribute("data-asset-id", adopted!);
    await restored.getByRole("button", { name: "重新生成", exact: true }).click();
    await expect.poll(() => prompts.length).toBe(3);
    expect(references[2]).toEqual([{ image_data: imageBase64 }]);
    await expect(versions.getByRole("listitem").first()).toContainText("当前");
    expect(imageCalls).toBe(2);
  } finally {
    await application?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("从剧本拆分镜支持空表、追加确认、取消和覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-split-script-"));
  const requests: string[] = [];
  let releaseAppend: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(Buffer.concat(chunks).toString());
    if (requests.length === 2)
      await new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
    const count = requests.length === 6 ? 12 : requests.length === 7 ? 2 : 1;
    const content = JSON.stringify(
      Array.from({ length: count }, (_, index) => ({
        scene: `第${requests.length}次结果${count > 1 ? `-${index + 1}` : ""}`,
        action: "",
        dialogue: "",
        shot: "中景",
        camera: "固定",
        duration: 4,
      })),
    );
    if (requests.length === 4) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "fixture rejected" } }));
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ choices: [{ message: { content } }] }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("缺少拆镜测试端口");
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      const plugin = list.ok && list.value.plugins.find(({ key }) => key === "openai");
      if (!plugin) throw new Error("缺少文本模型适配器");
      for (const model of ["fixture-a", "fixture-b", "text-only"]) {
        const saved = await settings.save({
          expectedRevision: 0,
          pluginHash: plugin.hash,
          approve: true,
          secret: "fixture",
          fields: {
            label: model,
            endpoint,
            model,
            allowLocal: true,
            agentEnabled: model !== "text-only",
            channel: { api: "chat_completions" },
          },
        });
        if (!saved.ok) throw new Error(saved.code);
      }
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page);
    const node = (id: string, x: number, data: object) => ({
      id,
      type: "canvas",
      position: { x, y: 0 },
      data,
    });
    const fixture = {
      format: "video-canvas/canvas",
      version: 1,
      assets: {},
      canvas: {
        title: "拆镜测试",
        nodes: [
          node("script", 0, { kind: "script", label: "源剧本", text: "雨夜列车驶入月台" }),
          node("before", -420, { kind: "script", label: "开场", text: "  第一声汽笛  " }),
          node("board", 420, {
            kind: "storyboard",
            label: "拆镜测试表",
            storyboard: { shots: [] },
          }),
        ],
        edges: [
          { id: "z", source: "before", target: "board" },
          { id: "a", source: "script", target: "board" },
        ],
      },
    };
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles({
      name: "split.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await chooseCanvasZoom(page, "适应画布");
    await page.locator(".react-flow__node").getByText("拆镜测试表", { exact: true }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    const board = page.getByRole("dialog", { name: "拆镜测试表" });
    const trigger = board.getByRole("button", { name: "从剧本拆分镜" });
    const scene = (number: number) =>
      board.getByRole("textbox", { name: `第 ${number} 镜的画面描述` });
    await expect(trigger).toHaveCount(2);
    const modelTrigger = board.locator(".shot-model-trigger");
    const modelMenu = page.getByRole("dialog", { name: "拆镜模型" });
    await modelTrigger.click();
    await expect(modelMenu.getByRole("button")).toHaveCount(2);
    const alternative = modelMenu.getByRole("button", { pressed: false });
    const chosen = (await alternative.innerText()).trim().match(/fixture-[ab]/)?.[0];
    expect(chosen).toBeTruthy();
    await alternative.click();
    await expect(modelTrigger).toContainText(chosen!);
    await modelTrigger.click();
    await page.keyboard.press("Escape");
    await expect(modelTrigger).toBeFocused();
    await board.getByRole("button", { name: "关闭分镜表" }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    await expect(modelTrigger).toContainText(chosen!);
    await board.getByRole("button", { name: "关闭分镜表" }).click();
    await page.locator(".shot-card-empty").getByRole("button", { name: "从剧本拆分镜" }).click();
    const cardScene = page.getByRole("region", { name: "分镜摘要" }).getByText("第1次结果");
    await expect(cardScene).toBeVisible();
    await cardScene.dblclick();
    await expect(scene(1)).toHaveValue("第1次结果");
    const freshRows = board.locator("[data-highlight=true]");
    await expect(freshRows).toHaveAccessibleName("镜头 1");
    expect(requests[0]).toContain("第一声汽笛\\n\\n雨夜列车驶入月台");
    expect(JSON.parse(requests[0]!).model).toBe(chosen);
    const confirmation = page.getByRole("alertdialog");
    for (const dismiss of ["Esc", "取消"]) {
      await trigger.click();
      await expect(confirmation).toHaveAccessibleName("分镜表里已有 1 个镜头");
      await expect(confirmation.getByRole("button", { name: "追加到末尾" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(confirmation.getByRole("button", { name: "覆盖" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(confirmation.getByRole("button", { name: "取消" })).toBeFocused();
      await page.mouse.click(1, 1);
      await expect(confirmation).toBeVisible();
      if (dismiss === "Esc") await page.keyboard.press("Escape");
      else await confirmation.getByRole("button", { name: "取消" }).click();
      await expect(confirmation).toBeHidden();
      if (dismiss === "Esc") {
        await expect(board).toHaveCount(0);
        await expect(page.getByRole("article", { name: "拆镜测试表" })).toBeFocused();
        await page.getByRole("button", { name: "编辑分镜" }).click();
      } else
        await expect
          .poll(() => page.evaluate(() => document.activeElement === document.body))
          .toBe(true);
      await expect(trigger).toBeEnabled();
      expect(requests).toHaveLength(1);
    }
    await trigger.click();
    await expect(confirmation.getByRole("button", { name: "追加到末尾" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(board.getByRole("progressbar", { name: "拆分中" })).toBeVisible();
    const cardPreview = page.locator(".shot-card-preview").filter({ hasText: "第1次结果" });
    await expect(cardPreview).toHaveCSS("animation-duration", "2s");
    await expect(page.locator(".shot-card-running .shot-split-spinner")).toHaveCSS(
      "animation-duration",
      "1s",
    );
    await expect(board.locator(".shot-table-content .split-skeleton-row")).toHaveCount(3);
    await expect(board.getByRole("button", { name: "拆分中" })).toBeDisabled();
    await modelTrigger.click();
    const unavailable = modelMenu.getByRole("button", { name: /不可选/ });
    await expect(unavailable).toHaveCount(2);
    await expect(unavailable.first()).toBeDisabled();
    await expect(unavailable.last()).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(modelTrigger).toBeFocused();
    await expect(board.getByRole("button", { name: "添加镜头" })).toBeDisabled();
    const lockedScene = board.getByLabel("第 1 镜的画面描述", { exact: true });
    await lockedScene.evaluate((element) => element.focus());
    await expect(lockedScene).not.toBeFocused();
    await expect.poll(() => typeof releaseAppend).toBe("function");
    releaseAppend?.();
    await expect(scene(2)).toHaveValue("第2次结果");
    await expect(cardPreview).toHaveCSS("animation-name", "none");
    await expect(scene(1)).toHaveValue("第1次结果");
    await expect(freshRows).toHaveAccessibleName("镜头 2");
    await expect(freshRows).toHaveCount(0, { timeout: 2500 });
    await trigger.click();
    await expect(confirmation).toHaveAccessibleName("分镜表里已有 2 个镜头");
    await confirmation.getByRole("button", { name: "覆盖" }).click();
    await expect(scene(1)).toHaveValue("第3次结果");
    await expect(freshRows).toHaveAccessibleName("镜头 1");
    await expect(scene(2)).toHaveCount(0);
    expect(requests).toHaveLength(3);
    const savedScenes = async () => {
      const graph = projectCanvas((await latestSnapshot(root)).canvas);
      const saved = graph.nodes.find((row) => row.data.label === "拆镜测试表");
      return saved?.type === "creative" && saved.data.storyboard?.map((shot) => shot.scene);
    };
    await expect.poll(savedScenes).toEqual(["第3次结果"]);
    const notice = board.getByRole("status").filter({ hasText: "已覆盖为 1 个镜头" });
    await notice.getByRole("button", { name: "撤销" }).click();
    await expect.poll(savedScenes).toEqual(["第1次结果", "第2次结果"]);
    await board.getByRole("button", { name: "关闭分镜表" }).click();
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(savedScenes).toEqual(["第3次结果"]);
    await page.locator(".react-flow__node").getByText("拆镜测试表", { exact: true }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    expect(requests).toHaveLength(3);
    await trigger.click();
    await confirmation.getByRole("button", { name: "追加到末尾" }).click();
    const error = board.getByRole("alert");
    await expect(error).toContainText("拆分镜失败");
    await expect(scene(1)).toHaveValue("第3次结果");
    await error.getByRole("button", { name: "重试" }).click();
    await expect(scene(2)).toHaveValue("第5次结果");
    await expect(scene(1)).toHaveValue("第3次结果");
    await expect(error).toBeHidden();
    expect(requests).toHaveLength(5);
    await modelTrigger.click();
    await modelMenu.getByRole("button", { name: /默认/ }).click();
    expect(await page.evaluate(() => localStorage.getItem("storyboard-split-model"))).toBeNull();
    await trigger.click();
    await confirmation.getByRole("button", { name: "覆盖" }).click();
    await expect(scene(12)).toHaveValue("第6次结果-12");
    const scrollBody = board.locator(".shot-table-scroll");
    await expect
      .poll(() =>
        scrollBody.evaluate(
          (body) => body.scrollHeight > body.clientHeight && body.scrollTop === 0,
        ),
      )
      .toBe(true);
    await trigger.click();
    await confirmation.getByRole("button", { name: "追加到末尾" }).click();
    await expect(freshRows).toHaveCount(2);
    await expect(freshRows.first()).toHaveAccessibleName("镜头 13");
    await expect(freshRows.last()).toHaveAccessibleName("镜头 14");
    await expect
      .poll(() =>
        scrollBody.evaluate((body) => {
          const fresh = body.querySelectorAll("[data-shot-id]")[12];
          if (!fresh) return false;
          const row = fresh.getBoundingClientRect();
          const viewport = body.getBoundingClientRect();
          return body.scrollTop > 0 && row.top >= viewport.top && row.bottom <= viewport.bottom + 1;
        }),
      )
      .toBe(true);
  } finally {
    releaseAppend?.();
    await application.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("分镜表手动图片按全能参考模型和步长生成视频", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-shot-omni-"));
  const icon = join(process.cwd(), "resources/icons/icon-32.png");
  const requests: {
    mode: string;
    images: string[];
    seconds: string;
    prompt: string;
    first_frame?: unknown;
  }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/videos") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    }
    response
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { message: "fixture received request" } }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("缺少视频测试端口");
  const application = await launchCanvas(root, icon);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    await installVideoChoices(page);
    const preferredVideo = await page.evaluate(async (endpoint) => {
      const api = window.desktop.settings;
      const list = await api.list({});
      const plugin = list.ok && list.value.plugins.find((item) => item.key === "agnes-video");
      if (!plugin) throw new Error("缺少全能参考视频适配器");
      const channel = await api.channelSave({
        approve: true,
        expectedRevision: 0,
        secret: "fixture-key",
        fields: {
          name: "分镜参考渠道",
          endpoint,
          enabled: true,
          allowLocal: true,
          sort: 1,
          headers: [],
        },
      });
      if (!channel.ok) throw new Error(channel.code);
      const saved = await api.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        upstreamModel: "agnes-video-2.5-flash",
        pluginHash: plugin.hash,
        enabled: true,
        approve: true,
        settings: { as: "dataUrl" },
        config: {
          kind: "video",
          name: "只支持全能参考",
          description: "",
          sort: 150,
          modes: ["omni"],
          params: {
            duration: {
              values: ["4", "6", "8", "10", "12"],
              default: "4",
              range: { min: 4, max: 12, step: 2, open: true },
            },
          },
        },
      });
      if (!saved.ok) throw new Error(saved.code);
      return saved.value.id;
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page);
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await expect(page.getByRole("button", { name: "将icon-32.png加入画布" })).toBeVisible();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    const fixture = JSON.parse(
      await readFile(join(process.cwd(), "tests/fixtures/upstream-storyboard.canvas.json"), "utf8"),
    );
    const imported = fixture.canvas.nodes.find((node: { id: string }) => node.id === "video");
    imported.data.model = preferredVideo;
    imported.data.params.duration = 10;
    await (await chooser).setFiles({
      name: "saved-model.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await chooseCanvasZoom(page, "适应画布");
    await page.locator(".react-flow__node").getByText("雨夜分镜", { exact: true }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    const board = page.getByRole("dialog", { name: "雨夜分镜" });
    const existing = board.getByRole("group", { name: "镜头 1", exact: true });
    await expect(existing.getByText("实际 10s")).toHaveAttribute(
      "title",
      "所选视频模型只支持 4–12s",
    );
    await existing.getByLabel("时长（秒）").fill("5.2");
    await existing.getByRole("button", { name: "第 1 镜的操作" }).click();
    await page.getByRole("button", { name: "重新生成视频", exact: true }).click();
    await expect(existing.getByText("实际 6s")).toHaveAttribute(
      "title",
      "所选视频模型只支持 4–12s",
    );
    await expect
      .poll(
        async () =>
          projectCanvas((await latestSnapshot(root)).canvas).nodes.find(
            (node) => node.data.label === "月台视频",
          )?.data,
      )
      .toMatchObject({ videoDuration: 6, generation: { modelKey: preferredVideo } });
    expect(requests).toHaveLength(0);
    await board.getByRole("button", { name: "关闭分镜表" }).click();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "画布设置" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "新节点默认模型", exact: true })
      .click();
    const chooseDefault = page.getByRole("button", { name: "选择视频节点的默认模型" });
    await expect(chooseDefault).toHaveText(/sora-2/);
    await chooseDefault.click();
    await page.getByRole("menuitemradio", { name: /只支持全能参考/ }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator(".react-flow__node").getByText("雨夜分镜", { exact: true }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    const row = board.getByRole("group", { name: "镜头 2", exact: true });
    await row.getByLabel("时长（秒）").fill("7.2");
    await row.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect(row.getByText("实际 8s")).toHaveAttribute("title", "所选视频模型只支持 4–12s");
    const savedVideo = async () => {
      const graph = projectCanvas((await latestSnapshot(root)).canvas);
      const source = graph.nodes.find((node) => node.type === "creative" && node.data.storyboard);
      if (source?.type !== "creative") return;
      const shot = source.data.storyboard?.[1];
      if (!shot) return;
      const video = graph.nodes.find((node) => node.id === shot.videoNodeId);
      if (video?.type !== "creative") return;
      return {
        provider: video.data.generation?.providerId,
        mode: video.data.videoMode,
        duration: video.data.videoDuration,
        manual: video.data.manualReferenceIds,
        image: shot.imageAssetId,
        sources: graph.edges.filter((edge) => edge.target === video.id).map((edge) => edge.source),
        board: source?.id,
      };
    };
    await expect
      .poll(savedVideo)
      .toMatchObject({ provider: preferredVideo, mode: "omni", duration: 8 });
    const saved = (await savedVideo())!;
    expect(saved.manual).toEqual([saved.image]);
    expect(saved.sources).toEqual([saved.board]);
    await row.getByRole("button", { name: "去生成" }).click();
    await expect(page.getByRole("button", { name: "开始生成" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "生成方式" })).toHaveCount(0);
    expect(requests).toHaveLength(0);
    await page.getByRole("button", { name: "开始生成" }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({
      mode: "reference",
      seconds: "8",
      prompt: "特写，推。铁轨特写。",
    });
    expect(requests[0]?.images).toEqual([
      `data:image/png;base64,${await readFile(icon, "base64")}`,
    ]);
    expect(requests[0]).not.toHaveProperty("first_frame");
    const selectedVideo = await page.locator(".react-flow__node.selected").getAttribute("data-id");
    await chooseCanvasZoom(page, "适应画布");
    await page.locator(".react-flow__node").getByText("雨夜分镜", { exact: true }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    const handleFailure = row.getByRole("button", { name: "去处理" });
    await expect(handleFailure).toBeVisible();
    await expect(row.locator(".shot-video-failure")).toHaveAttribute("title", /\S/);
    await handleFailure.focus();
    await page.keyboard.press("Enter");
    await expect(board).toHaveCount(0);
    await expect(page.locator(".react-flow__node.selected")).toHaveAttribute(
      "data-id",
      selectedVideo!,
    );
    await page.getByRole("button", { name: "生成参数", exact: true }).click();
    await page.getByRole("slider").press("End");
    await page.keyboard.press("Escape");
    await chooseCanvasZoom(page, "适应画布");
    await page.locator(".react-flow__node").getByText("雨夜分镜", { exact: true }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    await expect(row.getByText("实际 12s")).toHaveAttribute("title", "所选视频模型只支持 4–12s");
    expect(requests).toHaveLength(1);
  } finally {
    await application.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("原版分镜表导入、复制行并重新导出时保留正确的图片和视频关联", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-storyboard-transfer-"));
  const application = await launchCanvas(root, join(process.cwd(), "resources/icons/icon-32.png"));
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page);
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    await expect(page.getByRole("button", { name: "将icon-32.png加入画布" })).toBeVisible();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const chooseFile = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooseFile).setFiles(
      join(process.cwd(), "tests/fixtures/upstream-storyboard.canvas.json"),
    );
    await expect(
      page.locator(".react-flow__node").getByText("雨夜分镜", { exact: true }),
    ).toBeVisible();
    await chooseCanvasZoom(page, "适应画布");
    await page.locator(".react-flow__node").getByText("雨夜分镜", { exact: true }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    const editor = page.getByRole("dialog", { name: "雨夜分镜" });
    await expect(editor.getByRole("heading", { name: "雨夜分镜" })).toBeVisible();
    await expect(editor.getByTitle("共 5.5 秒")).toHaveText("2 镜 · 00:06");
    await expect(editor.getByRole("img")).toHaveCount(2);
    await expect(editor.getByRole("button", { name: /拆为.*节点/ })).toHaveCount(0);
    await editor.getByRole("button", { name: "查看大图" }).first().click();
    const viewer = page.getByRole("dialog", { name: "媒体预览" });
    await expect(viewer.getByRole("img", { name: "镜头 01", exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "关闭", exact: true }).hover();
    await expect(viewer.getByText("关闭（Esc）", { exact: true })).toBeVisible();
    await expect(viewer.getByRole("button", { name: "上一个" })).toBeDisabled();
    await page.keyboard.press("ArrowRight");
    await expect(viewer.getByText("本分镜表 2 / 2")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "下一个" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "第 1 镜的操作" }).click();
    await page
      .getByRole("dialog", { name: "镜头操作" })
      .getByRole("button", { name: "复制镜头" })
      .click();
    await expect(editor.getByRole("img", { name: "镜头 02 的分镜图" })).toHaveCount(0);
    await editor.getByRole("button", { name: "第 3 镜的操作" }).click();
    await page
      .getByRole("dialog", { name: "镜头操作" })
      .getByRole("button", { name: "复制镜头" })
      .click();
    await expect(editor.getByRole("img", { name: "镜头 04 的分镜图" })).toBeVisible();
    await editor.getByRole("button", { name: "移除分镜图" }).last().click();
    await expect(editor.getByRole("img")).toHaveCount(2);
    await editor.getByRole("textbox", { name: "第 4 镜的画面描述" }).fill("遮罩关闭时保存第四镜");
    await page.mouse.click(2, 2);
    await expect(editor).toHaveCount(0);
    await expect
      .poll(async () => {
        const graph = projectCanvas((await latestSnapshot(root)).canvas);
        const board = graph.nodes.find((node) => node.data.label === "雨夜分镜");
        return board?.type === "creative" ? board.data.storyboard?.[3]?.scene : undefined;
      })
      .toBe("遮罩关闭时保存第四镜");
    const exported = test.info().outputPath("desktop-storyboard.canvas.json");
    await application.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.once("will-download", (_event, item) =>
        item.setSavePath(path),
      );
    }, exported);
    await projectAction(page, "导出画布");
    await expect
      .poll(() =>
        readFile(exported, "utf8").then(
          (text) => text.length,
          () => 0,
        ),
      )
      .toBeGreaterThan(0);
    const result = JSON.parse(await readFile(exported, "utf8"));
    const [board, image, video] = result.canvas.nodes;
    const shots = board.data.storyboard.shots;
    expect(shots).toHaveLength(4);
    expect(shots[0]).toMatchObject({
      id: "platform",
      imageNodeId: image.id,
      videoNodeId: video.id,
    });
    expect(shots[1]).not.toHaveProperty("imageNodeId");
    expect(shots[1]).not.toHaveProperty("videoNodeId");
    expect(shots[2]).toMatchObject({ id: "rail", image: { assetHash: image.data.assetHash } });
    expect(shots[3]).not.toHaveProperty("image");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("旧分镜同时保留手传图与节点图时缩略图和大图选用各自来源", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-storyboard-two-images-"));
  const icons = [32, 64].map((size) => join(process.cwd(), `resources/icons/icon-${size}.png`));
  const application = await launchCanvas(root, icons.join("\n"));
  try {
    const bytes = await readFile(icons[1]!);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const fixture = JSON.parse(
      await readFile("tests/fixtures/upstream-storyboard.canvas.json", "utf8"),
    );
    fixture.canvas.nodes[0].data.storyboard.shots[0].image = { assetHash: hash };
    fixture.assets[hash] = {
      kind: "image",
      mimeType: "image/png",
      byteSize: bytes.length,
      width: 64,
      height: 64,
      durationMs: 0,
      fileName: "icon-64.png",
    };
    const page = await application.firstWindow();
    await createCanvasProject(page);
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    await expect(page.getByRole("button", { name: "将icon-64.png加入画布" })).toBeVisible();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles({
      name: "dual.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await chooseCanvasZoom(page, "适应画布");
    await page.locator(".react-flow__node").getByText("雨夜分镜", { exact: true }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    const editor = page.getByRole("dialog", { name: "雨夜分镜" });
    await expect(editor.getByRole("img", { name: "镜头 01 的分镜图" })).toHaveJSProperty(
      "naturalWidth",
      64,
    );
    await editor.getByRole("button", { name: "查看大图" }).first().click();
    await expect(page.getByRole("dialog", { name: "媒体预览" }).getByText("32×32")).toBeVisible();
    await page.keyboard.press("Escape");
    await editor.getByRole("button", { name: "关闭分镜表" }).click();
    const readBoard = async () => {
      const graph = projectCanvas((await latestSnapshot(root)).canvas);
      const board = graph.nodes.find((node) => node.data.label === "雨夜分镜");
      return {
        edges: graph.edges,
        shot: board?.type === "creative" ? board.data.storyboard?.[0] : undefined,
      };
    };
    await expect.poll(async () => (await readBoard()).edges.length).toBe(2);
    const before = await readBoard();
    expect(before.shot?.imageNodeId).toBeTruthy();
    const imageNode = page.locator(".react-flow__node").filter({ hasText: "月台分镜图" });
    await imageNode.locator("header strong").click();
    await expect(imageNode).toHaveClass(/\bselected\b/);
    await imageNode.press("Backspace");
    const { imageNodeId, ...remaining } = before.shot!;
    await expect.poll(readBoard).toEqual({
      shot: remaining,
      edges: before.edges.filter((edge) => edge.target !== imageNodeId),
    });
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(readBoard).toEqual(before);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("分镜图选图上传和整行拖放替换复用节点、来源线与历史版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-shot-upload-"));
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    await page.evaluate(async () => {
      const list = await window.desktop.settings.list({});
      if (!list.ok) throw new Error(list.code);
      const adapter = list.value.plugins.find((plugin) => plugin.key === "agnes-video");
      if (!adapter) throw new Error("缺少视频适配器");
      const saved = await window.desktop.settings.save({
        expectedRevision: 0,
        pluginHash: adapter.hash,
        approve: true,
        secret: "fixture-key",
        fields: {
          label: "分镜首帧",
          model: "agnes-video-2.5-flash",
          endpoint: "http://127.0.0.1:9",
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!saved.ok) throw new Error(saved.code);
    });
    await createCanvasProject(page);
    await page.locator(".react-flow__pane").dblclick({ position: { x: 70, y: 100 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "分镜表", exact: true })
      .click();
    const board = page.getByRole("dialog", { name: "分镜表" });
    await page.locator(".shot-card-empty").getByRole("button", { name: "添加镜头" }).click();
    const chooser = page.waitForEvent("filechooser");
    await board.getByRole("button", { name: "上传分镜图" }).click();
    await (await chooser).setFiles(join(process.cwd(), "resources/icons/icon-32.png"));
    await expect(board.getByRole("img")).toBeVisible();
    const graph = async () => projectCanvas((await latestSnapshot(root)).canvas);
    await expect.poll(async () => (await graph()).edges).toHaveLength(1);
    const initial = await graph();
    const [edge] = initial.edges;
    const image = initial.nodes.find((node) => node.id === edge?.target);
    if (image?.type !== "creative") throw new Error("缺少分镜图片节点");
    expect(image.data).toMatchObject({ label: "镜头 01", kind: "image", uploaded: true });
    const source = initial.nodes.find((node) => node.id === edge?.source);
    expect(source?.type === "creative" && source.data.storyboard?.[0]?.imageNodeId).toBe(image.id);
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "drop-source";
      input.hidden = true;
      document.body.append(input);
    });
    await page
      .locator("#drop-source")
      .setInputFiles(join(process.cwd(), "resources/icons/icon-64.png"));
    await board.getByLabel("第 1 镜的画面描述").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(document.querySelector<HTMLInputElement>("#drop-source")!.files![0]!);
      element.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    await expect(board.locator(".shot-image-drop-hint")).toBeVisible();
    await expect(board.locator(".shot-image-actions")).toBeHidden();
    await board.getByLabel("第 1 镜的画面描述").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(document.querySelector<HTMLInputElement>("#drop-source")!.files![0]!);
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    const outputs = async () => {
      const node = (await graph()).nodes.find((node) => node.id === image.id);
      return node?.type === "creative" ? node.data.outputs : undefined;
    };
    await expect.poll(outputs).toHaveLength(2);
    await expect(board.locator(".shot-image-drop-hint")).toBeHidden();
    const result = await graph();
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toEqual(initial.edges);
    const updated = result.nodes.find((node) => node.id === image.id);
    expect(
      updated?.type === "creative" && updated.data.outputs?.map((output) => output.assetId),
    ).toEqual([image.data.assetId, updated?.type === "creative" && updated.data.assetId]);
    if (updated?.type !== "creative") throw new Error("替换后缺少原节点");
    expect(updated.data.assetId).not.toBe(image.data.assetId);
    expect(updated.data.activeOutputId).toBe(updated.data.outputs?.[1]?.id);
    const replaceChooser = page.waitForEvent("filechooser");
    await board.getByRole("button", { name: "替换", exact: true }).click();
    await (await replaceChooser).setFiles(join(process.cwd(), "resources/icons/icon-32.png"));
    await expect
      .poll(async () => {
        const restored = (await graph()).nodes.find((node) => node.id === image.id);
        return restored?.type === "creative"
          ? {
              asset: restored.data.assetId,
              active: restored.data.activeOutputId,
              history: restored.data.outputs?.map((output) => output.id),
            }
          : undefined;
      })
      .toEqual({
        asset: image.data.assetId,
        active: image.data.activeOutputId,
        history: updated.data.outputs?.map((output) => output.id),
      });
    await board.getByLabel("第 1 镜的画面描述").fill("向远处走");
    await board.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(async () => (await graph()).edges).toHaveLength(3);
    const seeded = await graph();
    const videoNode = seeded.nodes.find(
      (node) => node.type === "creative" && node.data.kind === "video",
    );
    expect(videoNode?.data).toMatchObject({
      videoMode: "i2v",
      videoDuration: 4,
      text: "中景，固定。向远处走。",
    });
    expect(
      seeded.edges
        .filter((edge) => edge.target === videoNode?.id)
        .map((edge) => edge.source)
        .sort(),
    ).toEqual([source!.id, image.id].sort());
    await board.getByRole("button", { name: "在画布中定位" }).click();
    await expect(board).toHaveCount(0);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("分镜表拖动手柄排序后重新编号，一次撤销恢复磁盘顺序", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-shot-order-"));
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page);
    await page.locator(".react-flow__pane").dblclick({ position: { x: 70, y: 100 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "分镜表", exact: true })
      .click();
    const board = page.getByRole("dialog", { name: "分镜表" });
    await page
      .locator(".react-flow__node.selected .shot-card-empty")
      .getByRole("button", { name: "添加镜头" })
      .click();
    await board.getByLabel("第 1 镜的画面描述").fill("列车进站");
    await board.getByRole("button", { name: "第 1 镜的操作" }).click();
    await page
      .getByRole("dialog", { name: "镜头操作" })
      .getByRole("button", { name: "在下方插入" })
      .click();
    const scene = board.getByLabel("第 2 镜的画面描述");
    await expect(scene).toBeFocused();
    await scene.fill("乘客下车");
    await scene.press("Tab");
    const savedScenes = async () => {
      const graph = projectCanvas((await latestSnapshot(root)).canvas);
      const boardNode = graph.nodes.find(
        (node) => node.type === "creative" && node.data.storyboard,
      );
      return boardNode?.type === "creative"
        ? boardNode.data.storyboard?.map((row) => row.scene)
        : undefined;
    };
    await expect.poll(savedScenes).toEqual(["列车进站", "乘客下车"]);
    const handle = board.getByRole("button", { name: "拖动第 2 镜排序" });
    await handle.hover();
    const destination = await board.getByRole("button", { name: "拖动第 1 镜排序" }).boundingBox();
    if (!destination) throw new Error("缺少首行手柄");
    await page.mouse.down();
    await page.mouse.move(destination.x + 8, destination.y + 4, { steps: 16 });
    await expect(board.getByLabel("第 1 镜的画面描述")).toHaveValue("乘客下车");
    await page.mouse.up();
    await expect.poll(savedScenes).toEqual(["乘客下车", "列车进站"]);
    await board.getByRole("button", { name: "关闭分镜表" }).click();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(savedScenes).toEqual(["列车进站", "乘客下车"]);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("分镜表按镜头拆分，支持撤销和重开恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-storyboard-e2e-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "分镜验收");
    await page.locator(".react-flow__pane").dblclick({ position: { x: 70, y: 100 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "分镜表", exact: true })
      .click();
    const board = page.getByRole("dialog", { name: "分镜表" });
    await expect(board).toHaveCount(0);
    await page
      .locator(".react-flow__node.selected .shot-card-empty")
      .getByText("还没有镜头")
      .dblclick();
    await expect(board.getByText("还没有镜头")).toBeVisible();
    await expect(board.getByTitle("共 0 秒")).toHaveText("0 镜 · 00:00");
    for (const [colorScheme, paper] of [
      ["dark", "oklch(0.205 0 0)"],
      ["light", "oklch(1 0 0)"],
    ] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(board).toHaveCSS("background-color", paper);
    }
    await expect(board.getByTitle("请先连接剧本节点").first().getByRole("button")).toBeDisabled();
    await board.getByRole("button", { name: "关闭分镜表" }).click();
    await page.locator(".shot-card-empty").getByRole("button", { name: "添加镜头" }).click();
    await expect(board.getByLabel("画面描述")).toBeFocused();
    await board.getByLabel("画面描述").fill("列车进站");
    const duration = board.getByLabel("时长（秒）").first();
    await duration.fill("61");
    await duration.press("Enter");
    await expect(duration).toHaveValue("60");
    await duration.fill("");
    await duration.press("Enter");
    await expect(duration).toHaveValue("60");
    await duration.fill("3.16");
    await duration.press("ArrowUp");
    await expect(duration).toHaveValue("3.7");
    const menuButton = (number: number) =>
      board.getByRole("button", { name: `第 ${number} 镜的操作` });
    await menuButton(1).click();
    await page
      .getByRole("dialog", { name: "镜头操作" })
      .getByRole("button", { name: "在上方插入" })
      .click();
    await expect(board.getByLabel("第 1 镜的画面描述")).toBeFocused();
    await menuButton(1).click();
    await expect(board.getByLabel("第 1 镜的画面描述")).toHaveAttribute("aria-invalid", "true");
    await page
      .getByRole("dialog", { name: "镜头操作" })
      .getByRole("button", { name: "删除镜头" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "镜头操作" }).getByText("删除第 1 镜？"),
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "镜头操作" })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(board).toBeVisible();
    await menuButton(1).click();
    await page
      .getByRole("dialog", { name: "镜头操作" })
      .getByRole("button", { name: "删除镜头" })
      .click();
    await page
      .getByRole("dialog", { name: "镜头操作" })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(board.getByLabel("画面描述")).toHaveCount(1);
    const savedRows = async () => {
      const node = projectCanvas((await latestSnapshot(root)).canvas).nodes.find(
        (node) => node.type === "creative" && node.data.storyboard,
      );
      return node?.type === "creative" ? node.data.storyboard : undefined;
    };
    await expect
      .poll(savedRows)
      .toEqual([expect.objectContaining({ scene: "列车进站", duration: 3.7 })]);
    const framing = board.getByRole("combobox", { name: "景别" });
    await framing.click();
    await expect(board.getByRole("listbox").getByRole("option")).toHaveCount(8);
    await board.getByRole("option", { name: "特写 BCU" }).click();
    const camera = board.getByRole("combobox", { name: "运镜" });
    await camera.click();
    await expect(board.getByRole("listbox").getByRole("option")).toHaveCount(13);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect
      .poll(savedRows)
      .toEqual([expect.objectContaining({ shot: "特写", camera: "航拍" })]);
    await framing.click();
    await expect(framing).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(framing).toBeFocused();
    await board.getByLabel("对白").fill("下一站到了");
    await board.getByLabel("对白").press("Tab");
    await board.getByLabel("对白").fill("未提交的对白");
    await page.keyboard.press("Escape");
    await expect(board).toHaveCount(0);
    await expect.poll(savedRows).toEqual([expect.objectContaining({ dialogue: "下一站到了" })]);
    await page.getByRole("button", { name: "编辑分镜" }).click();
    await board.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(board.getByRole("button", { name: "去生成" })).toBeVisible();
    await board.getByRole("button", { name: "关闭分镜表" }).click();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(1);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^分镜验收/ }).click();
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(1);
    await reopened
      .locator(".creative-card header strong")
      .filter({ hasText: /^分镜表$/ })
      .click();
    await reopened.getByRole("button", { name: "编辑分镜" }).click();
    await expect(reopened.getByLabel("画面描述")).toHaveValue("列车进站");
    await expect(reopened.getByLabel("时长（秒）")).toHaveValue("3.7");
    await expect(reopened.getByRole("combobox", { name: "景别" })).toContainText("特写");
    await expect(reopened.getByRole("combobox", { name: "运镜" })).toContainText("航拍");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ["图片", "视频"]) {
  test(`分镜${kind === "图片" ? "批量" : "逐镜确认"}生成${kind}追踪逐镜状态，只重试失败镜头`, async () => {
    test.setTimeout(75_000);
    const video = kind === "视频";
    const root = await mkdtemp(join(tmpdir(), "link-studio-storyboard-jobs-"));
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=";
    const prompts: string[] = [];
    const seconds: string[] = [];
    const requestedModels: string[] = [];
    let releaseImages: (() => void) | undefined;
    const imageGate = new Promise<void>((resolve) => {
      releaseImages = resolve;
    });
    let endpoint = "";
    let clip: Buffer | undefined;
    const server = createServer(async (request, response) => {
      if (video && request.method === "GET" && request.url?.startsWith("/agnesapi?")) {
        response.end(JSON.stringify({ status: "completed", url: `${endpoint}/clip.mp4` }));
        return;
      }
      if (video && request.method === "GET" && request.url === "/clip.mp4") {
        response.writeHead(200, { "content-type": "video/mp4" }).end(clip);
        return;
      }
      if (
        request.method !== "POST" ||
        request.url !== (video ? "/v1/videos" : "/v1/images/generations")
      ) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { prompt } = body;
      prompts.push(prompt);
      requestedModels.push(body.model);
      if (!video && /人群散去|站台清晨/.test(prompt)) await imageGate;
      if (video) seconds.push(body.seconds);
      response.setHeader("Content-Type", "application/json");
      if (prompt.includes("下车") && prompts.filter((text) => text === prompt).length === 1) {
        response.writeHead(400).end(JSON.stringify({ error: { message: "fixture rejected" } }));
        return;
      }
      response.end(
        JSON.stringify(video ? { id: `video-${prompts.length}` } : { data: [{ b64_json: png }] }),
      );
    });
    let application: Awaited<ReturnType<typeof launchCanvas>> | undefined;
    try {
      if (video) {
        const path = join(root, "fixture.mp4");
        const ffmpeg = join(
          process.cwd(),
          "out/media",
          `${process.platform}-${process.arch}`,
          "ffmpeg",
        );
        await runMediaProcess(ffmpeg, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=160x90:r=24:d=1",
          "-c:v",
          "h264_videotoolbox",
          "-allow_sw",
          "1",
          path,
        ]);
        clip = await readFile(path);
      }
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test endpoint");
      endpoint = `http://127.0.0.1:${address.port}`;
      application = await launchCanvas(root);
      const page = await application.firstWindow();
      await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
      const imageDefault = await page.evaluate(
        async ({ endpoint, video }) => {
          const settings = window.desktop.settings;
          const list = await settings.list({});
          if (!list.ok) throw new Error(list.code);
          const plugin = list.value.plugins.find(
            ({ key }) => key === (video ? "agnes-video" : "openai-image"),
          );
          if (!plugin) throw new Error("Missing media adapter");
          const result = await settings.save({
            expectedRevision: 0,
            pluginHash: plugin.hash,
            approve: true,
            secret: "fixture-image-key",
            fields: {
              label: "分镜测试渠道",
              model: video ? "agnes-video-2.5-flash" : "gpt-image-1",
              endpoint,
              allowLocal: true,
              agentEnabled: false,
              channel: {},
            },
          });
          if (!result.ok) throw new Error(result.code);
          if (!video) {
            const alternate = await settings.save({
              expectedRevision: 0,
              pluginHash: plugin.hash,
              approve: true,
              secret: "fixture-image-key",
              fields: {
                label: "备用图片模型",
                model: "gpt-image-1-mini",
                endpoint,
                allowLocal: true,
                agentEnabled: false,
                channel: {},
              },
            });
            if (!alternate.ok) throw new Error(alternate.code);
            return alternate.value.id;
          }
        },
        { endpoint, video },
      );
      await createCanvasProject(page, "分镜任务验收");
      if (!video) {
        await page.getByRole("button", { name: "更多", exact: true }).click();
        await page.getByRole("menuitem", { name: "画布设置" }).click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "新节点默认模型", exact: true })
          .click();
        await page.getByRole("button", { name: "选择图片节点的默认模型" }).click();
        await page.getByRole("menuitemradio", { name: /gpt-image-1-mini/ }).click();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "关闭", exact: true }).click();
      }
      await page.locator(".react-flow__pane").dblclick({ position: { x: 70, y: 100 } });
      await page
        .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
        .getByRole("menuitem", { name: "分镜表", exact: true })
        .click();
      const board = page.getByRole("dialog", { name: "分镜表" });
      await page
        .locator(".react-flow__node.selected .shot-card-empty")
        .getByText("还没有镜头")
        .dblclick();
      const first = board.getByRole("group", { name: "镜头 1", exact: true });
      const second = board.getByRole("group", { name: "镜头 2", exact: true });
      await board.getByRole("button", { name: "添加镜头" }).click();
      await first.getByLabel("画面描述").fill("进站");
      if (video) await first.getByLabel("时长（秒）").fill("4");
      await board.getByRole("button", { name: "添加镜头" }).click();
      await second.getByLabel("画面描述").fill("下车");
      const generateVideo = async (row: Locator, action: "去生成" | "去处理") => {
        await row.getByRole("button", { name: action }).click();
        await expect(board).toHaveCount(0);
        await page.getByRole("button", { name: "开始生成" }).click();
        await chooseCanvasZoom(page, "适应画布");
        await page
          .locator(".creative-card header strong")
          .filter({ hasText: /^分镜表$/ })
          .click();
        await page.getByRole("button", { name: "编辑分镜" }).click();
      };
      await expect(board.getByRole("button", { name: /拆为.*节点/ })).toHaveCount(0);
      await expect(board.getByLabel("批量生成模型")).toHaveCount(0);
      if (video) {
        await second.getByLabel("时长（秒）").fill("6");
        await second.getByLabel("时长（秒）").press("Enter");
        for (const row of [first, second])
          await row.getByRole("button", { name: "生成视频", exact: true }).click();
        expect(prompts).toHaveLength(0);
        await generateVideo(first, "去生成");
        await expect(first.getByText("已完成", { exact: true })).toBeVisible({ timeout: 15000 });
        await generateVideo(second, "去生成");
      } else {
        await board.getByRole("button", { name: "批量生成分镜图" }).click();
        expect(prompts).toHaveLength(0);
        await page.getByRole("alertdialog").getByRole("button", { name: "开始生成" }).click();
        await expect(first.getByRole("img")).toBeVisible({ timeout: 15000 });
      }
      await expect(second.getByText(video ? "失败 ·" : "生成失败", { exact: true })).toBeVisible();
      if (video) await generateVideo(second, "去处理");
      else {
        const failedCell = second.locator(".shot-image-frame");
        await expect(failedCell).toHaveAttribute("title", /\S/);
        await expect(failedCell.getByText("生成失败", { exact: true })).toBeVisible();
        await second.getByRole("button", { name: "拖动第 2 镜排序" }).press("Tab");
        await expect(
          failedCell.getByRole("button", { name: "重新生成", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Enter");
      }
      await expect(
        video ? second.getByText("已完成", { exact: true }) : second.getByRole("img"),
      ).toBeVisible({ timeout: 15_000 });
      expect([...prompts].sort()).toEqual([
        "中景，固定。下车。",
        "中景，固定。下车。",
        "中景，固定。进站。",
      ]);
      await expect(page.locator(".react-flow__edge")).toHaveCount(2);
      if (!video) {
        await board.getByRole("button", { name: "添加镜头" }).click();
        const third = board.getByRole("group", { name: "镜头 3", exact: true });
        await third.getByLabel("画面描述").fill("月台。");
        await third.getByLabel("对白").fill("再见");
        await third.getByRole("button", { name: "生成分镜图", exact: true }).click();
        await expect(third.getByRole("img")).toBeVisible();
        expect(prompts.at(-1)).toBe("中景，固定。月台。");
        const readImage = async () => {
          const graph = projectCanvas((await latestSnapshot(root)).canvas);
          const image = graph.nodes.find((node) => node.data.label === "镜头 03");
          return image?.type === "creative" ? image : undefined;
        };
        const original = await readImage();
        expect(original?.data.assetId).toBeTruthy();
        expect(original?.data.generation?.providerId).toBe(imageDefault);
        expect(new Set(requestedModels)).toEqual(new Set(["gpt-image-1-mini"]));
        await third.getByLabel("动作和走位").fill("挥手");
        await third.getByRole("button", { name: "第 3 镜的操作" }).click();
        await page
          .getByRole("dialog", { name: "镜头操作" })
          .getByRole("button", { name: "重新生成分镜图", exact: true })
          .click();
        await expect.poll(() => prompts.at(-1)).toBe("中景，固定。月台。挥手。");
        await expect(third.getByRole("img")).toBeVisible();
        await expect
          .poll(readImage)
          .toMatchObject({ id: original!.id, data: { text: "中景，固定。月台。挥手。" } });
        await expect(page.locator(".react-flow__edge")).toHaveCount(3);
        const batch = board.getByRole("button", { name: "批量生成分镜图", exact: true });
        await batch.click();
        await expect(board.getByText("每一镜都有分镜图了")).toBeVisible();
        const before = prompts.length;
        for (const [index, scene] of ["站台清晨", "人群散去", ""].entries()) {
          await board.getByRole("button", { name: "添加镜头" }).click();
          if (scene) await board.getByLabel(`第 ${index + 4} 镜的画面描述`).fill(scene);
        }
        const confirm = page.getByRole("alertdialog", { name: "生成 2 张分镜图？" });
        await batch.click();
        await expect(confirm).toContainText("另有 1 镜没写画面描述，这次先跳过。");
        await expect(confirm.getByRole("button", { name: "开始生成" })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(confirm.getByRole("button", { name: "取消" })).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(confirm.getByRole("button", { name: "开始生成" })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(confirm).toBeHidden();
        await expect(batch).toBeVisible();
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
        await batch.click();
        await confirm.getByRole("button", { name: "取消" }).click();
        await expect(confirm).toBeHidden();
        expect(prompts).toHaveLength(before);
        await batch.click();
        await confirm.getByRole("button", { name: "开始生成" }).click();
        await expect.poll(() => prompts.length).toBeGreaterThan(before);
        await batch.click();
        await expect(confirm).toBeHidden();
        await expect(board.getByText("还有 1 镜没写画面描述，写好再生成")).toBeVisible();
        await board.getByRole("button", { name: "关闭分镜表" }).click();
        await chooseCanvasZoom(page, "适应画布");
        const readFourth = async () => {
          const graph = projectCanvas((await latestSnapshot(root)).canvas);
          const image = graph.nodes.find((node) => node.data.label === "镜头 04");
          return image?.type === "creative" ? image : undefined;
        };
        const pendingImage = await readFourth();
        if (!pendingImage) throw new Error("缺少生成中的第四镜节点");
        const pendingCard = page.locator(`.react-flow__node[data-id="${pendingImage.id}"]`);
        await pendingCard.click();
        await pendingCard.press("ArrowRight");
        await expect
          .poll(async () => (await readFourth())?.position.x)
          .toBeGreaterThan(pendingImage.position.x);
        const moved = (await readFourth())!.position;
        releaseImages?.();
        await expect(pendingCard.locator("img").first()).toBeVisible();
        const generated = (await readFourth())!.data;
        expect(generated.outputs?.[0]?.assetId).toBeTruthy();
        await page.getByRole("button", { name: "撤销", exact: true }).click();
        await expect
          .poll(readFourth)
          .toMatchObject({ position: pendingImage.position, data: generated });
        await page.getByRole("button", { name: "重做", exact: true }).click();
        await expect.poll(readFourth).toMatchObject({ position: moved, data: generated });
        await page.locator(".shot-card-preview").dblclick();
        for (const index of [4, 5])
          await expect(
            board.getByRole("group", { name: `镜头 ${index}`, exact: true }).getByRole("img"),
          ).toBeVisible();
        expect(prompts.slice(before).sort()).toEqual([
          "中景，固定。人群散去。",
          "中景，固定。站台清晨。",
        ]);
        await expect(page.locator(".react-flow__edge")).toHaveCount(5);
        await batch.click();
        await expect(board.getByText("还有 1 镜没写画面描述，写好再生成")).toBeVisible();
        const savedGraph = projectCanvas((await latestSnapshot(root)).canvas);
        const newImages = savedGraph.nodes.filter((node) =>
          ["镜头 04", "镜头 05"].includes(node.data.label),
        );
        expect(newImages).toHaveLength(2);
        expect(new Set(newImages.map((node) => node.position.y)).size).toBe(2);
        await board.getByRole("button", { name: "关闭分镜表" }).click();
        const preview = page.getByRole("region", { name: "分镜摘要" });
        await expect(preview.locator(".shot-card-thumbs > div")).toHaveCount(5);
        await expect(preview.locator(".shot-card-thumbs strong")).toHaveText("+1");
        await expect(preview.locator(".shot-card-summary p")).toHaveText([
          "进站",
          "下车",
          "月台。",
          "站台清晨",
          "人群散去",
        ]);
        await expect(preview.getByText("还有 1 镜")).toBeVisible();
      }
      if (video) {
        expect(seconds.sort()).toEqual(["4", "6", "6"]);
        expect(prompts.every((prompt) => !prompt.includes("时长："))).toBe(true);
        const snapshot = await latestSnapshot(root);
        expect(
          Object.values(snapshot.assets).filter(({ mediaType }) => mediaType === "video"),
        ).toHaveLength(2);
        await board.getByRole("button", { name: "添加镜头" }).click();
        const third = board.getByRole("group", { name: "镜头 3", exact: true });
        await third.getByRole("button", { name: "生成视频", exact: true }).click();
        await expect(board.getByRole("alert")).toHaveText("先写第 03 镜的画面描述");
        await third.getByLabel("画面描述").fill("月台。");
        await third.getByLabel("动作和走位").fill("挥手。");
        await third.getByLabel("对白").fill("再见。");
        await third.getByRole("button", { name: "生成视频", exact: true }).click();
        const shotVideo = async () => {
          const graph = projectCanvas((await latestSnapshot(root)).canvas);
          const node = graph.nodes.find((node) => node.data.label === "镜头 03 视频");
          return node?.type === "creative" ? node : undefined;
        };
        await expect.poll(shotVideo).toMatchObject({
          data: { kind: "video", text: "中景，固定。月台。挥手。对白：再见。", videoDuration: 4 },
        });
        const videoId = (await shotVideo())?.id;
        await expect(third.getByText("实际 4s")).toBeVisible();
        await third.getByLabel("时长（秒）").fill("8");
        await third.getByLabel("对白").fill("明天见");
        await third.getByRole("button", { name: "第 3 镜的操作" }).click();
        await page
          .getByRole("dialog", { name: "镜头操作" })
          .getByRole("button", { name: "重新生成视频" })
          .click();
        await expect.poll(shotVideo).toMatchObject({
          id: videoId,
          data: { text: "中景，固定。月台。挥手。对白：明天见。", videoDuration: 8 },
        });
        await expect(page.locator(".react-flow__edge")).toHaveCount(3);
        await third.getByRole("button", { name: "去生成" }).click();
        await expect(board).toHaveCount(0);
        await expect(page.locator(".react-flow__node.selected")).toHaveAttribute(
          "data-id",
          videoId!,
        );
        await expect(page.getByRole("button", { name: "生成参数" })).toContainText("8秒");
        expect(prompts).toHaveLength(3);
        await page.getByRole("button", { name: "开始生成" }).click();
        await expect.poll(() => prompts.at(-1)).toBe("中景，固定。月台。挥手。对白：明天见。");
        expect(seconds.at(-1)).toBe("8");
        await expect
          .poll(async () => (await shotVideo())?.data.assetId, { timeout: 15000 })
          .toBeTruthy();
      }
    } finally {
      releaseImages?.();
      await application?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function selectDirectorLayer(editor: Locator, name: string) {
  const sidebar = editor.getByRole("complementary", { name: "属性栏" });
  await sidebar.getByRole("button", { name: "图层", exact: true }).click();
  await sidebar.getByText(name, { exact: true }).click();
  await sidebar.getByRole("button", { name: "属性", exact: true }).click();
}
async function seekDirector(editor: Locator, time: number) {
  const ruler = editor.locator(".dt-ruler"),
    bounds = (await ruler.boundingBox())!,
    duration = Number(
      await editor
        .getByRole("region", { name: "时间轴" })
        .getByLabel("时长", { exact: true })
        .inputValue(),
    );
  await editor.page().mouse.click(bounds.x + (bounds.width * time) / duration, bounds.y + 12);
}
test("导演台保存人物站位、机位画幅和关键帧", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-director-e2e-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "导演台验收");
    await page.locator(".react-flow__pane").dblclick({ position: { x: 70, y: 100 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "导演台", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "导演台" });
    await expect(editor).toHaveCount(0);
    const card = page.locator(".creative-card[data-director]");
    await expect(card.locator(".director-node-cameras")).toHaveText("机位15.0s");
    await expect(page.getByRole("toolbar", { name: "所选节点操作" })).toHaveCount(0);
    await expect(card.locator(".target")).toHaveCount(0);
    await expect(card.locator(".director-node-mask")).toHaveCount(0);
    await card.getByRole("button", { name: "进入导演台" }).focus();
    await page.keyboard.press("Enter");
    const undo = editor.getByRole("button", { name: "撤销（Ctrl+Z）" });
    const redo = editor.getByRole("button", { name: "重做（Ctrl+Shift+Z）" });
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await editor.getByTitle("切换视角").click();
    await editor.getByRole("menuitemradio", { name: "机位1" }).click();
    const preview = editor.getByRole("img", { name: "机位预览" });
    await preview.scrollIntoViewIfNeeded();
    const bounds = (await preview.boundingBox())!;
    const position = { x: bounds.width / 3, y: bounds.height / 3 };
    await preview.hover({ position });
    await page.mouse.down();
    await page.mouse.move(bounds.x + position.x + 40, bounds.y + position.y, { steps: 5 });
    await page.mouse.up();
    const yaw = editor.getByLabel("偏航");
    await expect(yaw).not.toHaveValue("0");
    await preview.press("Control+z");
    await expect(yaw).toHaveValue("0");
    await expect(undo).toBeDisabled();
    await preview.press("Control+Shift+z");
    await expect(yaw).not.toHaveValue("0");
    await undo.click();
    await redo.click();
    await undo.click();
    await preview.scrollIntoViewIfNeeded();
    await preview.hover({ position });
    const pitch = editor.getByLabel("俯仰"),
      fov = editor.getByLabel("FOV", { exact: true }),
      depth = editor.getByLabel("位置 Z"),
      initialPitch = Number(await pitch.inputValue());
    const wheel = (altKey = false) =>
      preview.dispatchEvent("wheel", { deltaY: 100, deltaMode: 0, altKey, cancelable: true });
    await wheel();
    await expect
      .poll(async () => Number(await pitch.inputValue()))
      .toBeCloseTo(initialPitch - 2, 6);
    await wheel();
    await expect
      .poll(async () => Number(await pitch.inputValue()))
      .toBeCloseTo(initialPitch - 4, 6);
    await expect(fov).toHaveValue("50");
    await undo.click();
    await expect.poll(async () => Number(await pitch.inputValue())).toBeCloseTo(initialPitch, 6);
    await expect(undo).toBeDisabled();
    await preview.hover({ position });
    await wheel(true);
    await expect
      .poll(async () => Number(await fov.inputValue()))
      .toBe(Math.round(50 * Math.exp(0.1)));
    await undo.click();
    await preview.focus();
    await page.keyboard.down("w");
    try {
      await expect.poll(async () => Number(await depth.inputValue())).toBeLessThan(3.95);
    } finally {
      await page.keyboard.up("w");
    }
    await expect(editor.getByLabel("高度", { exact: true })).toHaveValue("1.60");
    await undo.click();
    await expect(depth).toHaveValue("4.00");
    await expect(undo).toBeDisabled();
    await editor.getByTitle("切换视角").click();
    await editor.getByRole("menuitemradio", { name: "导演视角" }).click();
    await editor.getByRole("button", { name: "+ 人物" }).click();
    await expect(redo).toBeDisabled();
    await selectDirectorLayer(editor, "角色B");
    await editor.getByLabel("模型").selectOption("female");
    await editor.getByLabel("姿势").selectOption("wave");
    await expect(editor.getByRole("img", { name: "场景预览" })).toHaveAttribute(
      "data-figure-status",
      "ready",
    );
    await editor.getByLabel("位置 X").fill("2");
    await editor.getByRole("button", { name: "记录关键帧" }).click();
    await seekDirector(editor, 1.5);
    await editor.getByLabel("位置 X").fill("3");
    await editor.getByRole("button", { name: "记录关键帧" }).click();
    await seekDirector(editor, 0);
    await editor.getByRole("button", { name: "+ 道具" }).click();
    await selectDirectorLayer(editor, "立方体1");
    await editor.getByRole("combobox", { name: "形状" }).selectOption("table");
    await expect(editor.getByLabel("高", { exact: true })).toHaveValue("1.0");
    await editor.getByLabel("宽", { exact: true }).fill("1.8");
    await editor.getByRole("button", { name: "+ 机位" }).click();
    await editor.getByLabel("画幅").selectOption("9:16");
    await editor.getByLabel("看向").selectOption({ label: "角色B" });
    const target = await editor.getByLabel("看向").inputValue();
    await editor.getByRole("button", { name: "记录关键帧" }).click();
    const scenePreview = editor.getByRole("img", { name: "场景预览" });
    await scenePreview.press("ArrowLeft");
    await scenePreview.press("Shift+ArrowUp");
    await editor.getByTitle("切换视角").click();
    await editor.getByRole("menuitemradio", { name: "机位2" }).click();
    await expect(editor.getByRole("img", { name: "机位预览" })).toBeVisible();
    await expect(editor.getByRole("button", { name: "放大视角" })).toHaveCount(0);
    await expect
      .poll(async () => (await latestSnapshot(root)).canvas.nodes)
      .toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            director: expect.objectContaining({
              characters: [
                expect.objectContaining({ name: "角色A", yaw: 180, color: "#d4d4d8" }),
                expect.objectContaining({
                  id: target,
                  model: "female",
                  pose: "wave",
                  keys: [
                    expect.objectContaining({ t: 0, x: 2 }),
                    expect.objectContaining({ t: 1.5, x: 3 }),
                  ],
                }),
              ],
              cameras: [
                expect.objectContaining({ name: "机位1", x: 0, z: 4, aspect: "16:9", fov: 50 }),
                expect.objectContaining({
                  aspect: "9:16",
                  lookAt: target,
                  name: "机位2",
                  x: 3,
                  z: 3,
                  yaw: -45,
                  keys: [expect.objectContaining({ t: 0 })],
                }),
              ],
              props: [
                expect.objectContaining({ shape: "table", w: 1.8, h: 1, d: 1, x: 2, z: -1.5 }),
              ],
            }),
          }),
        }),
      ]);
    await expect(editor).toBeVisible();
    await editor.getByLabel("时长", { exact: true }).selectOption("6.5");
    await editor.getByRole("button", { name: "关闭（自动保存）" }).focus();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(card.locator(".director-node-cameras")).toHaveText("机位16.5s机位26.5s");
    await expect
      .poll(() =>
        card
          .locator(".director-node-body img")
          .evaluateAll((images) =>
            images.map((image) => [
              (image as HTMLImageElement).naturalWidth,
              (image as HTMLImageElement).naturalHeight,
            ]),
          ),
      )
      .toEqual([[270, 480]]);
    await expect
      .poll(async () => {
        const node = projectCanvas((await latestSnapshot(root)).canvas).nodes[0];
        return node?.type === "creative" ? node.data.directorThumbnailId : undefined;
      })
      .toBeTruthy();
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^导演台验收/ }).click();
    await reopened
      .locator(".creative-card header strong")
      .filter({ hasText: /^导演台$/ })
      .click();
    await expect(reopened.locator(".director-node-mask")).toBeVisible();
    await reopened.getByRole("button", { name: "进入导演台" }).click();
    const restored = reopened.getByRole("dialog", { name: "导演台" });
    await selectDirectorLayer(restored, "机位2");
    await expect(restored.getByLabel("画幅")).toHaveValue("9:16");
    await expect(restored.getByLabel("看向")).toHaveValue(target);
    await expect(restored.getByRole("button", { name: "机位2 · 0 秒" })).toBeVisible();
    await selectDirectorLayer(restored, "角色B");
    await expect(restored.getByLabel("模型")).toHaveValue("female");
    await expect(restored.getByLabel("姿势")).toHaveValue("wave");
    await expect(restored.getByRole("button", { name: "角色B · 1.95 秒" })).toBeVisible();
    await restored.getByRole("button", { name: "角色B · 1.95 秒" }).click();
    await restored.getByRole("button", { name: "记录关键帧" }).click();
    await expect(restored.getByRole("button", { name: /角色B · .* 秒/ })).toHaveCount(2);
    const key = restored.getByRole("button", { name: "角色B · 1.95 秒" }),
      start = (await key.boundingBox())!,
      ruler = (await restored.locator(".dt-ruler").boundingBox())!;
    await reopened.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await reopened.mouse.down();
    await reopened.mouse.move(ruler.x, start.y + start.height / 2, { steps: 8 });
    await reopened.mouse.up();
    await expect(restored.getByRole("button", { name: /角色B · .* 秒/ })).toHaveCount(1);
    await restored.getByRole("button", { name: "撤销（Ctrl+Z）" }).click();
    await restored.getByRole("button", { name: "撤销（Ctrl+Z）" }).click();
    await expect(restored.getByRole("button", { name: "角色B · 1.95 秒" })).toBeVisible();
    await selectDirectorLayer(restored, "立方体1");
    await expect(restored.getByRole("combobox", { name: "形状" })).toHaveValue("table");
    await expect(restored.getByLabel("宽", { exact: true })).toHaveValue("1.8");
    const prior = await latestSnapshot(root);
    await reopened.evaluate(() => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        if (type === "image/jpeg") document.body.dataset.redundantJpeg = "true";
        return toBlob.call(this, callback, type, quality);
      };
    });
    await restored.getByRole("button", { name: "关闭（自动保存）" }).click();
    await expect(restored).toHaveCount(0);
    await reopened.evaluate(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = new Proxy(get, {
        apply(target, receiver, args) {
          return args[0] === "webgl2" ? null : Reflect.apply(target, receiver, args);
        },
      });
    });
    await reopened.getByRole("button", { name: "进入导演台" }).click();
    await expect(
      reopened
        .getByRole("alert")
        .filter({ hasText: "当前浏览器不支持 3D（WebGL2），请用新版 Chrome / Edge 打开导演台" }),
    ).toBeVisible();
    await expect(restored).toHaveCount(0);
    await expect(reopened.locator("body")).not.toHaveAttribute("data-redundant-jpeg", "true");
    expect((await latestSnapshot(root)).assets).toEqual(prior.assets);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("导演台资产筛选、当前视角建机位、删除优先级和分栏持久化", async () => {
  const root = await mkdtemp(join(tmpdir(), "director-panels-"));
  const app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page, "分栏验收");
    await page.locator(".react-flow__pane").dblclick({ position: { x: 70, y: 100 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "导演台", exact: true })
      .click();
    const enter = page.getByRole("button", { name: "进入导演台" }),
      editor = page.getByRole("dialog", { name: "导演台" }),
      assets = editor.getByRole("complementary", { name: "资产", exact: true }),
      view = editor.getByTitle("切换视角"),
      main = editor.locator("main");
    await enter.click();
    const width = () => assets.evaluate((element) => element.getBoundingClientRect().width),
      divider = editor.getByRole("separator", { name: "资产面板宽度" });
    expect(await width()).toBe(272);
    const original = await main.locator("canvas").first().elementHandle(),
      monitor = await main.locator("canvas").last().elementHandle();
    await divider.focus();
    await page.keyboard.down("ArrowRight");
    try {
      await expect.poll(width).toBe(288);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    } finally {
      await page.keyboard.up("ArrowRight");
    }
    await divider.dblclick();
    await expect.poll(width).toBe(272);
    const bounds = (await divider.boundingBox())!;
    await page.mouse.move(bounds.x + 4, bounds.y + 84);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 36, bounds.y + 84, { steps: 5 });
    await page.mouse.up();
    await expect.poll(width).toBe(304);
    await main.getByRole("button", { name: "左右分栏" }).click();
    expect(
      await main
        .locator("canvas")
        .first()
        .evaluate((element, old) => element === old, original),
    ).toBe(true);
    expect(
      await main
        .locator("canvas")
        .last()
        .evaluate((element, old) => element === old, monitor),
    ).toBe(true);
    const viewport = main.getByRole("img", { name: "场景预览" });
    await expect(viewport).toHaveAttribute("data-figure-status", "ready");
    const box = (await viewport.boundingBox())!,
      projection = new PerspectiveCamera(50, box.width / box.height, 0.05, 200);
    projection.position.set(6.5, 5, 8.5);
    projection.lookAt(0, 1, 0);
    projection.updateMatrixWorld();
    await selectDirectorLayer(editor, "机位1");
    await editor.getByLabel("位置 X").fill("12");
    await editor.getByLabel("位置 X").press("Enter");
    function point(x: number, y: number, z: number) {
      const ndc = new Vector3(x, y, z).project(projection);
      return {
        x: box.x + ((1 + ndc.x) * box.width) / 2,
        y: box.y + ((1 - ndc.y) * box.height) / 2,
      };
    }
    const actor = point(0, 1, 0),
      axis = point(0.7, 0, 0),
      end = point(1.6, 0, 0);
    await page.mouse.click(actor.x, actor.y);
    const position = editor.getByLabel("位置 X");
    await expect(position).toHaveValue("0.00");
    await page.mouse.move(axis.x, axis.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();
    await expect(position).not.toHaveValue("0.00");
    expect(Number(await position.inputValue()) % 0.25).toBe(0);
    await editor.getByTitle("撤销（Ctrl+Z）").click();
    await expect(position).toHaveValue("0.00");
    await view.click();
    await expect(editor.getByRole("menuitemradio", { name: "导演视角" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(editor.getByRole("menuitemradio", { name: "机位1" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(view).toBeFocused();
    await expect(editor.getByRole("menu")).toHaveCount(0);
    const search = assets.getByPlaceholder("搜索素材");
    await expect(assets.locator("img")).toHaveCount(2);
    await assets.getByRole("tab", { name: "物体" }).click();
    await expect(assets.locator("img")).toHaveCount(14);
    await assets.getByRole("button", { name: "几何体", exact: true }).click();
    await expect(assets.locator("img")).toHaveCount(4);
    await search.fill("椅");
    await expect(assets.getByText("没有匹配的素材")).toBeVisible();
    await assets.getByRole("button", { name: "全部" }).click();
    await assets.getByTitle("添加椅子").click();
    await expect(editor.getByLabel("形状")).toHaveValue("chair");
    await search.fill("");
    await assets.getByRole("tab", { name: "机位" }).click();
    await assets.getByRole("button", { name: "折叠资产面板" }).click();
    await editor
      .getByRole("navigation", { name: "工具" })
      .getByTitle(/展开资产面板/)
      .click();
    await expect(assets.getByRole("tab", { name: "机位" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await assets.getByTitle("把当前导演视角变成一台机位").click();
    await expect(editor.getByLabel("位置 X")).toHaveValue("6.50");
    await expect(editor.getByLabel("高度", { exact: true })).toHaveValue("5.00");
    await expect(editor.getByLabel("位置 Z")).toHaveValue("8.50");
    await editor.getByRole("button", { name: "记录关键帧" }).click();
    await editor.getByRole("button", { name: "机位2 · 0 秒" }).click();
    await page.keyboard.press("Delete");
    await expect(editor.getByRole("button", { name: "机位2 · 0 秒" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "机位2", exact: true })).toBeVisible();
    await main.getByRole("button", { name: "机位2", exact: true }).focus();
    await page.keyboard.press("Backspace");
    await expect(main.getByRole("button", { name: "机位2", exact: true })).toHaveCount(0);
    await editor.getByTitle("撤销（Ctrl+Z）").click();
    await expect(main.getByRole("button", { name: "机位2", exact: true })).toBeVisible();
    const snap = editor.getByTitle(/^吸附：/),
      labels = editor.getByTitle("显示人物和机位名称"),
      rotate = editor.getByTitle("旋转（2）");
    await snap.click();
    await labels.click();
    await rotate.click();
    await editor.getByRole("button", { name: "关闭（自动保存）" }).click();
    await enter.click();
    await expect.poll(width).toBe(304);
    await expect(main.getByRole("button", { name: "收成浮窗" })).toBeVisible();
    await expect(snap).toHaveAttribute("aria-pressed", "false");
    await expect(labels).toHaveAttribute("aria-pressed", "false");
    await expect(rotate).toHaveAttribute("aria-pressed", "true");
    await expect(assets.getByRole("tab", { name: "机位" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("导演台运镜套用、播放、一次撤销和跨重启恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "director-motion-"));
  let app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page, "轨迹验收");
    await page.locator(".react-flow__pane").dblclick({ position: { x: 70, y: 100 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "导演台", exact: true })
      .click();
    await page.getByRole("button", { name: "进入导演台" }).click();
    const editor = page.getByRole("dialog", { name: "导演台" }),
      preset = editor.getByLabel("运镜预设"),
      apply = editor.getByRole("button", { name: "套用", exact: true });
    await expect(preset).toBeDisabled();
    await editor
      .getByRole("region", { name: "机位画面" })
      .getByRole("button", { name: "机位1", exact: true })
      .click();
    await expect(preset).toHaveValue("dollyIn");
    await expect(preset.locator("option")).toHaveCount(13);
    await preset.selectOption("orbit");
    await expect(editor.getByLabel("运镜强度")).toHaveValue("90");
    await editor.getByLabel("运镜强度").fill("120");
    await apply.click();
    const keys = editor.getByRole("button", { name: /机位1 · [\d.]+ 秒/ });
    await expect(keys).toHaveCount(11);
    await editor.getByRole("button", { name: "撤销（Ctrl+Z）" }).click();
    await expect(keys).toHaveCount(0);
    await editor.getByRole("button", { name: "重做（Ctrl+Shift+Z）" }).click();
    await expect(keys).toHaveCount(11);
    await editor.press("Space");
    await expect(editor.getByRole("button", { name: "暂停（空格）" })).toBeVisible();
    await editor.press("Space");
    await expect(editor.getByRole("button", { name: "播放（空格）" })).toBeVisible();
    await preset.selectOption("follow");
    await expect(editor.getByLabel("运镜强度")).toHaveCount(0);
    await apply.click();
    await expect(editor.getByText(/跟拍效果等同固定机位/)).toBeVisible();
    await editor.getByRole("button", { name: "撤销（Ctrl+Z）" }).click();
    const x = editor.getByLabel("位置 X"),
      draft = editor.getByText(/^未记录：按 K 把改动写到/);
    await seekDirector(editor, 1.2);
    await x.fill("12");
    await x.press("Enter");
    await expect(draft).toBeVisible();
    await expect(keys).toHaveCount(11);
    await seekDirector(editor, 1.3);
    await expect(draft).toHaveCount(0);
    await expect(x).not.toHaveValue("12.00");
    await x.fill("13");
    await apply.focus();
    await page.keyboard.press("k");
    await expect(draft).toHaveCount(0);
    await expect(keys).toHaveCount(12);
    await expect(editor.getByRole("button", { name: "机位1 · 1.3 秒" })).toBeVisible();
    await editor.getByRole("button", { name: "撤销（Ctrl+Z）" }).click();
    await expect(keys).toHaveCount(11);
    await x.fill("77");
    await x.press("Enter");
    await expect(draft).toBeVisible();
    await editor.getByRole("button", { name: "关闭（自动保存）" }).click();
    const scene = async () => {
      const node = projectCanvas((await latestSnapshot(root)).canvas).nodes[0];
      return node?.type === "creative" ? node.data.director : undefined;
    };
    await expect.poll(async () => (await scene())?.cameras[0]?.keys.length).toBe(11);
    const last = (await scene())!.cameras[0]!.keys.at(-1)!;
    expect(last.t).toBe(5);
    expect(last.z).toBeCloseTo(-2, 6);
    expect(last.x).toBeCloseTo(-Math.sqrt(12), 6);
    expect((await scene())!.cameras[0]!.keys.every((key) => key.x !== 77)).toBe(true);
    await app.close();
    app = await launchCanvas(root);
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: /^轨迹验收/ }).click();
    await reopened.getByRole("button", { name: "进入导演台" }).click();
    await expect(reopened.getByRole("button", { name: /机位1 · [\d.]+ 秒/ })).toHaveCount(11);
    await expect(reopened.getByText(/^未记录：按 K 把改动写到/)).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("导演台取消、多机位导出和失败重试将视频和首帧连回画布", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "link-studio-director-export-e2e-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "导演台导出验收");
    await page.locator(".react-flow__pane").dblclick({ position: { x: 70, y: 100 } });
    await page
      .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
      .getByRole("menuitem", { name: "导演台", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "导演台" });
    await page.getByText("在 3D 空间中设计角色、机位与镜头").dblclick();
    const exportButton = editor.getByRole("button", { name: "导出视频", exact: true });
    const modal = page.getByRole("dialog", { name: "导出运镜预览视频", exact: true });
    await editor.getByRole("button", { name: "+ 人物" }).click();
    await editor.getByRole("button", { name: "+ 机位" }).click();
    await editor.getByLabel("画幅").selectOption("9:16");
    await editor.getByLabel("时长", { exact: true }).selectOption("15");
    await exportButton.click();
    await expect(modal.getByLabel("机位2")).toBeChecked();
    await expect(modal.getByLabel("机位1")).not.toBeChecked();
    await modal.getByRole("button", { name: "开始导出（1）" }).click();
    await modal.getByRole("button", { name: "取消导出" }).click();
    await expect(modal.getByRole("status")).toHaveText("已取消导出，已编码的内容已丢弃");
    expect(Object.keys((await latestSnapshot(root)).assets)).toHaveLength(0);
    await modal.getByRole("button", { name: "取消", exact: true }).click();
    await editor.getByLabel("时长", { exact: true }).selectOption("1");
    await expect(editor.getByLabel("时长", { exact: true })).toHaveValue("1");
    await exportButton.click();
    await modal.getByLabel("机位1").check();
    await modal.getByRole("button", { name: "开始导出（2）" }).click();
    await modal.getByRole("button", { name: "回到画布查看" }).click({ timeout: 25_000 });
    const snapshot = async () => projectCanvas((await latestSnapshot(root)).canvas);
    await expect.poll(async () => (await snapshot()).edges.length).toBe(4);
    const graph = await snapshot(),
      director = graph.nodes.find((node) => node.type === "creative" && node.data.director)!;
    expect(graph.nodes.map((node) => node.data.label)).toEqual([
      "导演台",
      "导演台·机位2",
      "导演台·机位2·首帧",
      "导演台·机位1",
      "导演台·机位1·首帧",
    ]);
    expect(graph.edges.map((edge) => [edge.source, edge.target]).sort()).toEqual(
      graph.nodes
        .slice(1)
        .map((node) => [director.id, node.id])
        .sort(),
    );
    for (const node of graph.nodes.slice(1))
      expect(node.position.x - director.position.x).toBeCloseTo(656, 0);
    const byY = graph.nodes.slice(1).sort((left, right) => left.position.y - right.position.y);
    for (let index = 1; index < byY.length; index++) {
      const above = byY[index - 1]!;
      const height = above.data.label.includes("机位2") ? 576 : 324;
      expect(byY[index]!.position.y - above.position.y - height).toBeGreaterThanOrEqual(39.99);
    }
    const state = await latestSnapshot(root),
      files = Object.values(state.assets).filter((asset) => asset.origin === "derived");
    expect(files.map((asset) => asset.displayName).sort()).toEqual(
      [
        "导演台_机位1.mp4",
        "导演台_机位2.mp4",
        "导演台_首帧_机位1.png",
        "导演台_首帧_机位2.png",
      ].sort(),
    );
    const portrait = files.find((asset) => asset.displayName === "导演台_机位2.mp4")!,
      output = join(
        await projectDirectory(root),
        "assets",
        "sha256",
        portrait.sha256.slice(0, 2),
        portrait.sha256,
      );
    const ffprobe = join(
      process.cwd(),
      "out/media",
      `${process.platform}-${process.arch}`,
      "ffprobe",
    );
    const probe = JSON.parse(
      (
        await runMediaProcess(ffprobe, [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name,codec_type,width,height,nb_frames,avg_frame_rate:format=duration,format_name",
          "-of",
          "json",
          output,
        ])
      ).toString(),
    );
    expect(probe.streams).toEqual([
      {
        codec_name: "h264",
        codec_type: "video",
        width: 720,
        height: 1280,
        nb_frames: "24",
        avg_frame_rate: "24/1",
      },
    ]);
    expect(probe.format.format_name.split(",")).toContain("mp4");
    expect(Number(probe.format.duration)).toBeCloseTo(1, 1);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await snapshot()).nodes.length).toBe(1);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await snapshot()).edges.length).toBe(4);
    await page.getByRole("button", { name: "进入导演台" }).click();
    await exportButton.click();
    await modal.getByLabel("机位1").check();
    await modal.getByLabel("1080p").check();
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        if (type === "image/png" && this.width === 1080) {
          HTMLCanvasElement.prototype.toBlob = original;
          callback(null);
          return;
        }
        return original.call(this, callback, type, quality);
      };
    });
    await modal.getByRole("button", { name: "开始导出（2）" }).click();
    await expect(modal.getByText("无法读取首帧图")).toBeVisible();
    await expect.poll(async () => (await snapshot()).edges.length).toBe(6);
    await modal.getByLabel("同时导出首帧图").uncheck();
    await modal.getByRole("button", { name: "重试该机位" }).click();
    await modal.getByRole("button", { name: "回到画布查看" }).click();
    await expect.poll(async () => (await snapshot()).edges.length).toBe(7);
    const final = await snapshot();
    expect(final.nodes.map((node) => node.data.label)).toContain("导演台·机位2 2");
    expect(
      Object.values((await latestSnapshot(root)).assets).filter(
        (item) => item.origin === "derived" && item.metadata.height === 1920,
      ),
    ).toHaveLength(1);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^导演台导出验收/ }).click();
    await expect(reopened.locator(".react-flow__node")).toHaveCount(8);
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(7);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("画布视频可排序、混音并导出成片，结果回写项目文件", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "link-studio-composition-e2e-"));
  const red = join(root, "red.mp4");
  const blue = join(root, "blue.mp4");
  const bgm = join(root, "bgm.wav");
  const output = join(root, "composition.mp4");
  const ffmpeg = join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg");
  await runMediaProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=24:d=0.8",
    "-c:v",
    "h264_videotoolbox",
    "-allow_sw",
    "1",
    "-pix_fmt",
    "yuv420p",
    red,
  ]);
  await runMediaProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:r=24:d=0.8",
    "-c:v",
    "h264_videotoolbox",
    "-allow_sw",
    "1",
    "-pix_fmt",
    "yuv420p",
    blue,
  ]);
  await runMediaProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=44100:duration=2",
    "-c:a",
    "pcm_s16le",
    bgm,
  ]);
  const application = await launchCanvas(root, `${red}\n${blue}\n${bgm}`);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "成片导出验收");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await expect(page.getByText("red.mp4", { exact: true })).toBeVisible();
    await expect(page.getByText("blue.mp4", { exact: true })).toBeVisible();
    await expect(page.getByText("bgm.wav", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "将red.mp4加入画布" }).click();
    await page.getByRole("button", { name: "将blue.mp4加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();

    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path,
      })) as typeof dialog.showSaveDialog;
    }, output);
    await projectAction(page, "导出成片");
    const composition = page.getByRole("dialog", { name: "预览与导出成片" });
    await expect(composition.locator(".composition-preview article strong")).toHaveText([
      "red.mp4",
      "blue.mp4",
    ]);
    await composition.getByRole("button", { name: "下移red.mp4" }).click();
    await expect(composition.locator(".composition-preview article strong")).toHaveText([
      "blue.mp4",
      "red.mp4",
    ]);
    await composition.getByLabel("背景音乐").selectOption({ label: "bgm.wav" });
    await composition.getByLabel("输出规格").selectOption("m0-360p");
    await composition.getByLabel("源音量").fill("0.8");
    await composition.getByLabel("BGM 音量").fill("0.35");
    await composition.getByRole("button", { name: "选择位置并导出 MP4" }).click();
    await expect(composition).toBeHidden({ timeout: 30_000 });
    const preview = page.getByRole("dialog", { name: "灵可成片.mp4" });
    await expect(preview.locator("video")).toBeVisible();
    await expect.poll(async () => (await readdir(root)).includes("composition.mp4")).toBe(true);
    const snapshot = await latestSnapshot(root);
    expect(Object.values(snapshot.assets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: "灵可成片.mp4",
          origin: "derived",
          mediaType: "video",
          metadata: expect.objectContaining({ compositionId: expect.any(String) }),
        }),
      ]),
    );
    expect(Object.values(snapshot.compositions)).toEqual([
      expect.objectContaining({
        sourceAssetIds: expect.any(Array),
        bgmAssetId: expect.any(String),
        recipe: expect.objectContaining({ profile: expect.objectContaining({ id: "m0-360p" }) }),
      }),
    ]);
    await preview.getByRole("button", { name: "关闭预览" }).click();
    await projectAction(page, "关闭项目");
    await expect(page.getByRole("button", { name: /^新建画布项目/ })).toBeVisible();
    const savedRevision = (await latestSnapshot(root)).revision;
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => {
        throw new Error("无效素材不应打开保存对话框");
      }) as typeof dialog.showSaveDialog;
    });
    const videoAssetId = Object.values(snapshot.assets).find(
      ({ displayName }) => displayName === "red.mp4",
    )?.assetId;
    if (!videoAssetId) throw new Error("缺少导出源视频");
    const invalidBgm = await page.evaluate(async (videoAssetId) => {
      const projects = window.desktop.projects;
      const recent = await projects.listRecent({});
      const entry = recent.ok ? recent.value.projects[0] : undefined;
      if (!entry) throw new Error("缺少最近项目");
      const opened = await projects.openRecent({ recentEntryId: entry.recentEntryId });
      if (!opened.ok || opened.value.disposition !== "opened") throw new Error("无法重新打开项目");
      const { projectHandle, revision } = opened.value.session;
      return projects.exportComposition({
        projectHandle,
        expectedRevision: revision,
        operationId: crypto.randomUUID(),
        videoAssetIds: [videoAssetId],
        bgmAssetId: crypto.randomUUID(),
      });
    }, videoAssetId);
    expect(invalidBgm).toMatchObject({ ok: false, error: { code: "EXPORT_SOURCE_MISSING" } });
    expect((await latestSnapshot(root)).revision).toBe(savedRevision);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function createVideoFixture(root: string, size = "160x90") {
  const clip = join(root, "source.mp4");
  const ffmpeg = join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg");
  await runMediaProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=s=${size}:r=24:d=1.2`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.2",
    "-c:v",
    "h264_videotoolbox",
    "-allow_sw",
    "1",
    "-c:a",
    "aac",
    "-shortest",
    clip,
  ]);
  return clip;
}

test("视频裁切保留原节点，片段和来源连线可撤销、重做和重开", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-trim-e2e-"));
  let application = await launchCanvas(root, await createVideoFixture(root, "90x160"));
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "裁切验收");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将source.mp4加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const portrait = page.locator(".react-flow__node.selected .creative-card");
    await expect(portrait).toHaveCSS("width", "324px");
    await expect(portrait).toHaveCSS("height", "576px");
    await page.getByRole("button", { name: "视频修剪", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "裁切视频" });
    const submit = dialog.getByRole("button", { name: "裁切并加入画布" });
    await dialog.getByRole("spinbutton", { name: /入点/ }).fill("0.25");
    await dialog.getByRole("spinbutton", { name: /出点/ }).fill("0.2");
    await expect(submit).toBeDisabled();
    await dialog.getByRole("spinbutton", { name: /出点/ }).fill("0.85");
    await dialog.getByRole("checkbox", { name: "移除音轨" }).check();
    await submit.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(1);
    const snapshot = await latestSnapshot(root);
    const source = Object.values(snapshot.assets).find(
      (asset) => asset.displayName === "source.mp4",
    );
    expect(source).toBeDefined();
    expect(Object.values(snapshot.assets)).toContainEqual(
      expect.objectContaining({
        origin: "derived",
        mediaType: "video",
        metadata: expect.objectContaining({
          sourceAssetId: source?.assetId,
          trimStartMs: 250,
          trimEndMs: 850,
          audioRemoved: true,
        }),
      }),
    );
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^裁切验收/ }).click();
    await expect(
      reopened
        .locator(".react-flow__node")
        .filter({ has: reopened.locator("header strong").filter({ hasText: /^source$/ }) }),
    ).toHaveCount(1);
    await expect(
      reopened.locator(".react-flow__node").filter({ hasText: "source-裁切.mp4" }),
    ).toHaveCount(1);
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(1);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("视频节点快捷截首尾帧的输出像素、来源和撤销", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-quickframes-"));
  const clip = await createVideoFixture(root);
  const app = await launchCanvas(root, clip);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page, "快捷选帧");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将source.mp4加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const trigger = page.getByRole("button", { name: "截取帧", exact: true });
    await trigger.press("ArrowDown");
    const menu = page.getByRole("menu", { name: "截取帧" });
    await expect(menu.getByRole("menuitem")).toHaveText(["首帧", "尾帧", "自定义"]);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    for (const [index, label] of ["首帧", "尾帧"].entries()) {
      await trigger.click();
      await menu.getByRole("menuitem", { name: label }).click();
      await expect(page.locator('.node-media[data-kind="image"] img')).toHaveCount(index + 1);
      await expect(page.getByRole("slider", { name: "播放位置" })).toHaveCount(0);
    }
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges.length).toBe(2);
    const state = await latestSnapshot(root);
    const graph = projectCanvas(state.canvas);
    const video = graph.nodes.find(
      (node) => node.type === "creative" && node.data.kind === "video",
    );
    if (!video) throw new Error("原视频节点丢失");
    const ffmpeg = join(
      process.cwd(),
      "out/media",
      `${process.platform}-${process.arch}`,
      "ffmpeg",
    );
    const decode = (path: string) =>
      runMediaProcess(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          path,
          "-map",
          "0:v:0",
          "-fps_mode",
          "passthrough",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { maxStdoutBytes: 4 * 1024 * 1024 },
      );
    const all = await decode(clip);
    const bytes = 160 * 90 * 3;
    const endpoints = [all.subarray(0, bytes), all.subarray(-bytes)];
    expect(endpoints[0]?.equals(endpoints[1] ?? Buffer.alloc(0))).toBe(false);
    for (const [index, label] of ["首帧", "尾帧"].entries()) {
      const child = graph.nodes.find((node) => node.data.label === `${video.data.label}-${label}`);
      const asset =
        child?.type === "creative" && child.data.assetId
          ? state.assets[child.data.assetId]
          : undefined;
      if (!asset || !child) throw new Error(`缺少${label}图片`);
      expect(state.canvas.edges).toContainEqual(
        expect.objectContaining({ source: video.id, target: child.id }),
      );
      const output = await decode(
        join(
          await projectDirectory(root),
          "assets",
          "sha256",
          asset.sha256.slice(0, 2),
          asset.sha256,
        ),
      );
      expect(output.length).toBe(bytes);
      expect(output.equals(endpoints[index] ?? Buffer.alloc(0))).toBe(true);
    }
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("视频节点提帧并保留派生图片和来源连线", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-frame-e2e-"));
  let application = await launchCanvas(root, await createVideoFixture(root));
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "提帧验收");
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将source.mp4加入画布" }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await page.getByRole("button", { name: "截取帧", exact: true }).click();
    await page.getByRole("menuitem", { name: "自定义" }).click();
    const dialog = page.getByRole("group", { name: "截取帧" });
    const time = dialog.getByRole("slider", { name: "播放位置" });
    const extract = dialog.getByRole("button", { name: "确认", exact: true });
    const capture = dialog.getByRole("button", { name: "截取帧", exact: true });
    await expect(extract).toBeDisabled();
    await expect(dialog.locator(".frame-strip img")).toHaveCount(16);
    await capture.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "截取帧", exact: true }).click();
    await page.getByRole("menuitem", { name: "自定义" }).click();
    await expect(extract).toBeDisabled();
    await expect(time).toBeEnabled();
    await time.press("Shift+ArrowRight");
    await expect(time).toHaveAttribute("aria-valuenow", "1");
    await capture.click();
    await capture.click();
    await expect(dialog.getByText("这一帧已经截过了")).toBeVisible();
    await time.press("ArrowLeft");
    await capture.click();
    await time.click({ position: { x: 25, y: 12 } });
    await time.press("Shift+ArrowRight");
    await time.press("Shift+ArrowRight");
    await capture.click();
    await dialog.getByRole("button", { name: "丢弃 #2" }).click();
    expect(
      Object.values((await latestSnapshot(root)).assets).filter(
        (item) => item.origin === "derived",
      ),
    ).toHaveLength(0);
    await extract.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.node-media[data-kind="image"] img')).toHaveCount(2);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(2);
    expect(Object.values((await latestSnapshot(root)).assets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "derived",
          mediaType: "image",
          metadata: expect.objectContaining({
            width: 160,
            height: 90,
            timeMs: 1000,
            sourceAssetId: expect.any(String),
          }),
        }),
      ]),
    );
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^提帧验收/ }).click();
    await expect(reopened.locator('.node-media[data-kind="image"] img')).toHaveCount(2);
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(2);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function drag(page: Page, locator: Locator, offset: { x: number; y: number }) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("拖动目标不可见");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + offset.x, y + offset.y, { steps: 12 });
  await page.mouse.up();
}

async function sampleArrangement(button: Locator) {
  return button.evaluate(async (element) => {
    const samples: { nodes: string; edge: string | null; frame: string | undefined }[] = [];
    const sample = () =>
      samples.push({
        nodes: Array.from(document.querySelectorAll<HTMLElement>(".react-flow__node-creative"))
          .map((node) => node.style.transform)
          .join(";"),
        edge: document.querySelector(".react-flow__edge-path")?.getAttribute("d") ?? null,
        frame: document.querySelector<HTMLElement>(".react-flow__node-group")?.style.width,
      });
    sample();
    (element as HTMLButtonElement).click();
    const start = performance.now();
    do {
      await new Promise(requestAnimationFrame);
      sample();
    } while (performance.now() - start < 380);
    return samples;
  });
}

test("图片端口菜单按目标模型能力禁用文生图并允许图片参考音频", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-media-ports-"));
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    await page.evaluate(async () => {
      const api = window.desktop.settings;
      const list = await api.list({});
      if (!list.ok) throw new Error(list.code);
      for (const [key, model] of [
        ["openai-image", "dall-e-3"],
        ["doubao-audio", "fixture-audio"],
      ] as const) {
        const plugin = list.value.plugins.find((entry) => entry.key === key);
        if (!plugin) throw new Error(key);
        const saved = await api.save({
          expectedRevision: 0,
          pluginHash: plugin.hash,
          approve: true,
          secret: "fixture-only",
          fields: {
            label: model,
            endpoint: "https://example.invalid",
            model,
            agentEnabled: false,
            allowLocal: false,
            channel: {},
          },
        });
        if (!saved.ok) throw new Error(saved.code);
      }
    });
    await createCanvasProject(page);
    await page.getByRole("button", { name: /^图片生成 文字或参考图出图/ }).click();
    await expect(page.getByRole("button", { name: "选择模型" })).toHaveText("dall-e-3");
    const imageId = await page.locator(".react-flow__node.selected").getAttribute("data-id");
    const pane = page.locator(".react-flow__pane:visible");
    await page
      .locator(".react-flow__handle-right")
      .dragTo(pane, { targetPosition: await blankCanvasPosition(pane, { x: 250, y: 190 }) });
    const menu = page.getByRole("menu", { name: /^(画布菜单|添加节点)$/ });
    await expect(menu.getByRole("menuitem", { name: "图片生成", exact: true })).toBeDisabled();
    await menu.getByRole("menuitem", { name: "音频", exact: true }).click();
    await expect(page.getByRole("button", { name: "选择模型" })).toHaveText("fixture-audio");
    const audioId = await page.locator(".react-flow__node.selected").getAttribute("data-id");
    await expect
      .poll(async () => (await latestSnapshot(root)).canvas.edges)
      .toContainEqual(expect.objectContaining({ source: imageId, target: audioId }));
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("默认视频模型决定音频拉线候选，以及多选时允许的来源和撤销边界", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-model-fan-"));
  let application = await launchCanvas(root);
  try {
    let page = await application.firstWindow();
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    const models = await page.evaluate(async () => {
      const api = window.desktop.settings,
        list = await api.list({});
      if (!list.ok) throw Error(list.code);
      const ids: Record<string, string> = {};
      for (const [key, model] of [
        ["sora", "sora-2"],
        ["doubao-video", "doubao-seedance-2-0"],
      ] as const) {
        const plugin = list.value.plugins.find((entry) => entry.key === key)!;
        const saved = await api.save({
          expectedRevision: 0,
          pluginHash: plugin.hash,
          approve: true,
          secret: "fixture-only",
          fields: {
            label: model,
            endpoint: "https://example.invalid",
            model,
            agentEnabled: false,
            allowLocal: false,
            channel: {},
          },
        });
        if (!saved.ok) throw Error(saved.code);
        ids[model] = saved.value.id;
      }
      return ids;
    });
    await createCanvasProject(page, "多选连线模型回放");
    const nodes = ["image", "audio"].map((kind, index) => ({
      id: kind,
      type: "canvas",
      position: { x: 500, y: 300 + index * 520 },
      origin: [1, 0.5],
      data: { kind, label: `来源-${kind}` },
    }));
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles({
      name: "fan.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "video-canvas/canvas",
          version: 1,
          assets: {},
          canvas: { title: "扇出", nodes, edges: [] },
        }),
      ),
    });
    const disk = async () => projectCanvas((await latestSnapshot(root)).canvas);
    const state = async () => {
      const graph = await disk();
      const labels = new Map(graph.nodes.map((node) => [node.id, node.data.label]));
      return {
        positions: graph.nodes
          .filter((node) => node.data.label.startsWith("来源-"))
          .map((node) => node.position),
        models: graph.nodes.flatMap((node) =>
          node.type === "creative" && node.data.kind === "video"
            ? [[node.data.generation?.providerId, node.data.videoMode]]
            : [],
        ),
        sources: graph.edges
          .map((edge) => [labels.get(edge.source), labels.get(edge.target)])
          .sort(),
      };
    };
    const base = {
      positions: [
        { x: -76, y: 138 },
        { x: -76, y: 658 },
      ],
      models: [],
      sources: [],
    };
    await expect.poll(state).toEqual(base);
    const choose = async (model: string) => {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await page.getByRole("menuitem", { name: "画布设置" }).click();
      const settings = page.getByRole("dialog");
      await settings.getByRole("button", { name: "新节点默认模型", exact: true }).click();
      await settings.getByRole("button", { name: "选择视频节点的默认模型" }).click();
      await page
        .getByRole("menuitemradio")
        .filter({ has: page.getByText(model, { exact: true }) })
        .click();
      await page.keyboard.press("Escape");
      await settings.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(settings).toBeHidden();
    };
    const menu = page.getByRole("menu", { name: /^(画布菜单|添加节点)$/ }),
      video = menu.getByRole("menuitem", { name: "视频生成", exact: true });
    const audio = page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("来源-audio", { exact: true }) });
    const accepted = {
      ...base,
      models: [[models["sora-2"], "i2v"]],
      sources: [["来源-image", "视频"]],
    };
    const omni = {
      ...base,
      models: [[models["doubao-seedance-2-0"], "omni"]],
      sources: [
        ["来源-audio", "视频"],
        ["来源-image", "视频"],
      ],
    };
    const pane = page.locator(".react-flow__pane:visible");
    const viewport = page.locator(".react-flow__viewport:visible");
    const audioOutput = audio.locator(".react-flow__handle-right.connectable");
    for (const reference of [false, true]) {
      await choose(reference ? "doubao-seedance-2-0" : "sora-2");
      await chooseCanvasZoom(page, "适应画布");
      await expect
        .poll(() =>
          viewport.evaluate(async (element) => {
            const transform = getComputedStyle(element).transform;
            for (let frame = 0; frame < 3; frame += 1) {
              await new Promise(requestAnimationFrame);
              if (getComputedStyle(element).transform !== transform) return false;
            }
            return true;
          }),
        )
        .toBe(true);
      const blank = await blankCanvasPosition(pane, { x: 125, y: 125 });
      const bounds = await pane.boundingBox();
      if (!bounds) throw new Error("画布不可见");
      const drop = { x: bounds.x + blank.x, y: bounds.y + blank.y };
      await audioOutput.hover();
      await page.mouse.down();
      try {
        await page.mouse.move(drop.x, drop.y, { steps: 12 });
        await expect(page.locator(".react-flow__connection-path")).toBeVisible();
        expect(
          await pane.evaluate(
            (element, point) => document.elementFromPoint(point.x, point.y) === element,
            drop,
          ),
          "音频连线的落点必须仍是画布空白",
        ).toBe(true);
      } finally {
        await page.mouse.up();
      }
      await expect(menu.getByText("引用该节点生成", { exact: true })).toBeVisible();
      if (reference) await expect(video).toBeEnabled();
      else await expect(video).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await clickBlankCanvas(page);
      await audio.locator("header strong").click({ modifiers: ["ControlOrMeta"] });
      await page.getByText("来源-image", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
      await page.getByRole("button", { name: "引用选中的节点生成", exact: true }).click();
      await expect(menu.getByRole("menuitem", { name: "上传素材" })).toBeDisabled();
      await expect(menu.getByRole("menuitem", { name: "从资产库添加" })).toBeEnabled();
      const point = await page
        .locator(".canvas-fan-lines path")
        .first()
        .evaluate((element) => {
          const path = element as SVGPathElement;
          const end = path.getPointAtLength(path.getTotalLength());
          return { x: end.x, y: end.y };
        });
      await video.click();
      if (!reference)
        await expect(
          page
            .locator(
              "[data-sonner-toaster][data-x-position=center][data-y-position=top] [data-type=info]",
            )
            .getByText("1 个节点接不到视频上，已跳过", { exact: true }),
        ).toBeVisible();
      const target = await page
        .locator(".react-flow__node.selected .react-flow__handle-left")
        .boundingBox();
      if (!target) throw Error("新视频没有输入端口");
      expect(Math.abs(target.x + target.width / 2 - point.x)).toBeLessThan(2);
      expect(Math.abs(target.y + target.height / 2 - point.y)).toBeLessThan(2);
      await expect.poll(state).toEqual(reference ? omni : accepted);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect.poll(state).toEqual(base);
      await page.getByRole("button", { name: "重做", exact: true }).click();
      await expect.poll(state).toEqual(reference ? omni : accepted);
      if (!reference) {
        await page.getByRole("button", { name: "撤销", exact: true }).click();
        await expect.poll(state).toEqual(base);
      }
    }
    await application.close();
    application = await launchCanvas(root);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /^多选连线模型回放/ }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect.poll(state).toEqual(omni);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("两种视频模型的落点、重复连线切方式及重开状态与固定版一致", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-model-drop-"));
  const requests: { content: { type: string; text?: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/v3/contents/generations/tasks")
      return response.end(JSON.stringify({ status: "cancelled" }));
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.end(JSON.stringify({ error: { message: "回环收到无素材请求" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("缺少本地回环服务");
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /^新建画布项目/ }).waitFor();
    const models = await page.evaluate(async (endpoint) => {
      const api = window.desktop.settings,
        list = await api.list({});
      if (!list.ok) throw Error(list.code);
      const ids: string[] = [];
      for (const [adapter, model] of [
        ["doubao-video", "doubao-seedance-2-0"],
        ["sora", "sora-2"],
      ] as const) {
        const plugin = list.value.plugins.find((item) => item.key === adapter);
        if (!plugin) throw Error("视频适配器缺失");
        const saved = await api.save({
          expectedRevision: 0,
          approve: true,
          secret: "fixture-only",
          pluginHash: plugin.hash,
          fields: {
            label: model,
            endpoint,
            model,
            allowLocal: true,
            agentEnabled: false,
            channel: {},
          },
        });
        if (!saved.ok) throw Error(saved.code);
        ids.push(saved.value.id);
      }
      return ids;
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page, "模式落点");
    const sources = ["image", "character", "audio", "storyboard"];
    const modes = ["t2v", "t2v", "i2v", "t2v", "t2v"];
    const graph = [
      ...sources.map((kind, index) => ({
        id: kind,
        type: "canvas",
        position: { x: 0, y: index * 540 },
        data: { kind, label: "来源-" + kind },
      })),
      ...modes.map((op, index) => ({
        id: "v" + index,
        type: "canvas",
        position: { x: 850, y: index * 540 },
        data: {
          kind: "video",
          label: "模式-" + index,
          model: models[[1, 3, 4].includes(index) ? 1 : 0],
          params: { op },
        },
      })),
    ];
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles({
      name: "op.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "video-canvas/canvas",
          version: 1,
          assets: {},
          canvas: {
            title: "模式",
            nodes: graph,
            edges: [{ id: "old", source: "image", target: "v0" }],
          },
        }),
      ),
    });
    const card = (label: string) =>
      page.locator(".react-flow__node").filter({ has: page.getByText(label, { exact: true }) });
    await expect(card("模式-4")).toBeVisible();
    await chooseCanvasZoom(page, "适应画布");
    await expect
      .poll(async () =>
        page.locator(".react-flow__viewport").evaluate(async (element) => {
          const before = element.getBoundingClientRect();
          await new Promise((resolve) => setTimeout(resolve, 120));
          const after = element.getBoundingClientRect();
          return before.x === after.x && before.width === after.width;
        }),
      )
      .toBe(true);
    const disk = async () => {
      const current = projectCanvas((await latestSnapshot(root)).canvas);
      const labels = new Map(current.nodes.map((node) => [node.id, node.data.label]));
      return {
        modes: current.nodes
          .flatMap((node) =>
            node.type === "creative" && node.data.label.startsWith("模式-")
              ? [[node.data.label, node.data.videoMode]]
              : [],
          )
          .sort(),
        edges: current.edges
          .map((edge) => [labels.get(edge.source), labels.get(edge.target)])
          .sort(),
      };
    };
    const expectedEdges = [["来源-image", "模式-0"]];
    for (const [kind, index, wanted] of [
      ["image", 0, "omni"],
      ["image", 1, "i2v"],
      ["character", 2, "i2v"],
      ["audio", 3, false],
      ["storyboard", 4, "t2v"],
    ] as const) {
      const start = card("来源-" + kind).locator(".react-flow__handle-right"),
        end = card("模式-" + index).locator("article");
      const box = await end.boundingBox();
      if (!box) throw Error("目标未挂载");
      await start.hover();
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.4, { steps: 12 });
      try {
        await expect(end).toHaveCSS("opacity", wanted ? "1" : "0.35");
        await expect(end, `拖过模式-${index}`).toHaveCSS(
          "transform",
          wanted ? /^matrix3d\(/ : "none",
        );
      } finally {
        await page.mouse.up();
      }
      if (wanted) {
        modes[index] = wanted;
        if (index !== 0) expectedEdges.push(["来源-" + kind, "模式-" + index]);
      } else {
        const menu = page.getByRole("menu", { name: /^(画布菜单|添加节点)$/ });
        await expect(menu.getByText("引用该节点生成", { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await expect.poll(disk).toEqual({
        modes: modes.map((value, at) => ["模式-" + at, value]),
        edges: expectedEdges.sort(),
      });
    }
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^模式落点/ }).click();
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(4);
    await chooseCanvasZoom(reopened, "适应画布");
    await reopened
      .locator("header strong")
      .filter({ hasText: /^模式-0$/ })
      .click();
    await expect(reopened.getByRole("tab", { name: "全能参考" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const emptyReference = reopened.getByRole("button", {
      name: "引用：来源-image，点击定位到节点",
    });
    await expect(emptyReference).toHaveAttribute("title", "来源-image · 还没生成\n点击定位到节点");
    await expect(emptyReference).toHaveCSS("opacity", "1");
    const composer = reopened.getByRole("region", { name: "生成确认" });
    await composer.getByRole("textbox", { name: "生成提示词" }).fill("空图尚未生成");
    const submit = composer.getByRole("button", { name: "开始生成" });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect
      .poll(() => requests.map((body) => body.content))
      .toEqual([[{ type: "text", text: "空图尚未生成" }]]);
    await expect
      .poll(
        async () =>
          Object.values((await latestSnapshot(root)).jobs).some(
            (job) =>
              job &&
              typeof job === "object" &&
              !Array.isArray(job) &&
              ["cancelled", "failed"].includes(String(job.status)),
          ),
        { timeout: 12_000 },
      )
      .toBe(true);
  } finally {
    await application.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("添加节点菜单保留指针锚点，工具按钮可用键盘打开并返回焦点", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-canvas-menu-"));
  const app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page);
    const trigger = page.getByRole("button", { name: "添加节点", exact: true });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const toolbarMenu = page.getByRole("menu", { name: "添加节点", exact: true });
    await expect(toolbarMenu.getByRole("menuitem").first()).toBeFocused();
    const button = await trigger.boundingBox();
    if (!button) throw new Error("缺少工具栏添加按钮");
    await expect
      .poll(async () => (await toolbarMenu.boundingBox())?.x)
      .toBe(button.x + button.width + 14);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await addCanvasNode(page, "文本");
    await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
    const point = await page.evaluate(() => ({ x: innerWidth - 23, y: innerHeight - 93 }));
    await page.mouse.dblclick(point.x, point.y);
    const menu = page.getByRole("menu", { name: "画布菜单" });
    await expect(menu).toBeFocused();
    await expect.poll(async () => (await menu.boundingBox())?.y).toBe(point.y + 2);
    const box = await menu.boundingBox();
    expect(box?.width).toBe(200);
    expect(box?.height).toBe(86);
    expect(box?.x).toBe(point.x + 23 - 205);
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem").last()).toBeFocused();
    await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(300);
    await page.keyboard.press("Home");
    const imageItem = menu.getByRole("menuitem", { name: "图片生成", exact: true });
    await expect(imageItem).toBeEnabled();
    await expect(imageItem).toBeFocused();
    await imageItem.press("Enter");
    const image = page.locator(".react-flow__node.selected");
    await expect(image.locator("header strong")).toHaveText("图片");
    const bounds = await image.boundingBox();
    expect(bounds?.x).toBeCloseTo(point.x, 0);
    expect(bounds?.y).toBeCloseTo(point.y, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("从文本端口拉到空白处可取消或创建已连线的下游节点", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-link-menu-"));
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "拉线建节点");
    await page.getByRole("button", { name: /^文本 脚本、分镜描述/ }).click();
    const source = page.locator(".react-flow__node").first();
    const sourceId = await source.getAttribute("data-id");
    const handle = source.locator(".react-flow__handle-right");
    const pane = page.locator(".react-flow__pane");
    const menu = page.getByRole("menu", { name: /^(画布菜单|添加节点)$/ });
    const drag = () => handle.dragTo(pane, { targetPosition: { x: 250, y: 190 } });
    const start = await handle.boundingBox();
    if (!start) throw new Error("缺少起始端口");
    await handle.hover({ position: { x: start.width * 2, y: start.height * 5 } });
    await expect(handle.locator(".canvas-port-icon")).toHaveCSS("opacity", "1");
    await expect.poll(() => handle.evaluate((port) => port.matches(":hover"))).toBe(true);
    const surface = await pane.boundingBox();
    if (!surface) throw new Error("缺少画布");
    await page.mouse.down();
    try {
      await page.mouse.move(surface.x + 250, surface.y + 190, { steps: 12 });
      await expect(page.locator(".react-flow__connection-path")).toBeVisible();
    } finally {
      await page.mouse.up();
    }
    await expect(menu.getByRole("menuitem", { name: "文本", exact: true })).toBeDisabled();
    const preview = page.locator(".canvas-fan-lines path");
    const endpoints = await preview.evaluate((element) => {
      const path = element as SVGPathElement;
      const from = path.getPointAtLength(0);
      const to = path.getPointAtLength(path.getTotalLength());
      return { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
    });
    const portBox = await handle.boundingBox();
    const paneBox = await pane.boundingBox();
    if (!portBox || !paneBox) throw new Error("缺少连线端点");
    expect(Math.abs(endpoints.from.x - portBox.x - portBox.width / 2)).toBeLessThan(2);
    expect(Math.abs(endpoints.from.y - portBox.y - portBox.height / 2)).toBeLessThan(2);
    expect(Math.abs(endpoints.to.x - paneBox.x - 250)).toBeLessThan(2);
    expect(Math.abs(endpoints.to.y - paneBox.y - 190)).toBeLessThan(2);
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(menu).toBeHidden();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    const historyButton = page.getByRole("button", { name: "任务历史", exact: true });
    const historyBox = await historyButton.boundingBox();
    if (!historyBox) throw new Error("缺少任务历史按钮");
    await handle.dragTo(historyButton, {
      targetPosition: { x: historyBox.width - 3, y: historyBox.height / 2 },
    });
    await expect(menu.getByText("引用该节点生成", { exact: true })).toBeVisible();
    await expect(preview).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "任务历史" })).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await drag();
    await menu.getByRole("menuitem", { name: "图片生成", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect
      .poll(async () => (await latestSnapshot(root)).canvas.edges)
      .toContainEqual(expect.objectContaining({ source: sourceId }));
    const image = page
      .locator(".react-flow__node")
      .filter({ has: page.locator("header strong").filter({ hasText: /^图片$/ }) });
    const textCard = source.locator("article");
    const textBox = await source.boundingBox();
    if (!textBox) throw new Error("文本卡片不可见");
    await image.locator(".react-flow__handle-right").hover();
    await page.mouse.down();
    try {
      await page.mouse.move(textBox.x + textBox.width / 3, textBox.y + textBox.height / 3, {
        steps: 10,
      });
      await expect(textCard).toHaveCSS("opacity", "1");
      await expect(textCard).toHaveCSS("transform", /^matrix3d\(/);
    } finally {
      await page.mouse.up();
    }
    await expect(textCard).toHaveCSS("opacity", "1");
    await expect(textCard).toHaveCSS("transform", "none");
    await expect(menu).toBeVisible();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await page.keyboard.press("Escape");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("图片线经过七类节点，视觉反馈与实际建线分别对齐原版", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-tilt-kinds-"));
  const app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    await createCanvasProject(page);
    const kinds = ["script", "image", "video", "audio", "storyboard", "director", "character"];
    const graph = ["start", ...kinds].map((kind, index) => ({
      id: kind,
      type: "canvas",
      position: { x: (index % 4) * 750, y: Math.floor(index / 4) * 650 },
      data: {
        kind: kind === "start" ? "image" : kind,
        label: "反馈-" + kind,
        ...(kind === "image" ? { uploaded: true } : {}),
        ...(kind === "director" ? { scene: defaultDirectorScene() } : {}),
      },
    }));
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles({
      name: "feedback.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          format: "video-canvas/canvas",
          version: 1,
          assets: {},
          canvas: { title: "七类拉线", nodes: graph, edges: [] },
        }),
      ),
    });
    const card = (kind: string) =>
      page
        .locator(".react-flow__node")
        .filter({ has: page.getByText("反馈-" + kind, { exact: true }) })
        .locator("article");
    await expect(card("character")).toBeVisible();
    await chooseCanvasZoom(page, "适应画布");
    const linked: string[][] = [];
    for (const reverse of [false, true])
      for (const kind of kinds) {
        const port = card("start").locator(".react-flow__handle-" + (reverse ? "left" : "right"));
        const eligible = reverse
          ? !["director", "audio", "video"].includes(kind)
          : ["audio", "video"].includes(kind);
        const tilts = !["image", "video", "audio"].includes(kind) || eligible;
        const body = card(kind),
          target = await body.boundingBox();
        if (!target) throw new Error(`缺少 ${kind} 节点`);
        await port.hover();
        await page.mouse.down();
        try {
          await page.mouse.move(target.x + target.width * 0.36, target.y + target.height * 0.4, {
            steps: 12,
          });
          await expect(body).toHaveCSS("opacity", tilts ? "1" : "0.35");
          await expect(body).toHaveCSS("transform", tilts ? /^matrix3d\(/ : "none");
        } finally {
          await page.mouse.up();
        }
        await expect(body).toHaveCSS("transform", "none");
        await expect(body).toHaveCSS("opacity", "1");
        if (eligible)
          linked.push(reverse ? ["反馈-" + kind, "反馈-start"] : ["反馈-start", "反馈-" + kind]);
        else {
          await expect(page.getByRole("menu", { name: /^(画布菜单|添加节点)$/ })).toBeVisible();
          await page.keyboard.press("Escape");
        }
        await expect(page.locator(".react-flow__edge")).toHaveCount(linked.length);
      }
    await expect
      .poll(async () => {
        const graph = projectCanvas((await latestSnapshot(root)).canvas);
        return graph.edges.map((edge) => [
          graph.nodes.find((node) => node.id === edge.source)?.data.label,
          graph.nodes.find((node) => node.id === edge.target)?.data.label,
        ]);
      })
      .toEqual(linked);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("从视频输入端上传四张图片，按三列单独放下；重开后可手动连接已上传素材", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-upload-links-"));
  const files = [0, 1, 2, 3].map((index) => join(root, `参考${index}.png`));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    for (const [index, file] of files.entries()) {
      const encoded = await page.evaluate((width) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = 8;
        return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
      }, 8 + index);
      await writeFile(file, Buffer.from(encoded, "base64"));
    }
    await createCanvasProject(page, "素材来源线");
    await page.getByRole("button", { name: /^视频生成 文生/ }).click();
    const target = page.locator(".react-flow__node").first();
    const id = await target.getAttribute("data-id");
    const pane = page.locator(".react-flow__pane:visible");
    await target
      .locator(".react-flow__handle-left")
      .dragTo(pane, { targetPosition: await blankCanvasPosition(pane, { x: 250, y: 170 }) });
    await chooseCanvasFiles(
      page,
      page
        .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
        .getByRole("menuitem", { name: "上传素材" }),
      files,
    );
    await expect(
      page
        .locator("[data-sonner-toast][data-type=info]")
        .getByText("4 个节点接不到刚才那根线上，已单独放下", { exact: true }),
    ).toBeVisible();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.nodes.length).toBe(5);
    const graph = (await latestSnapshot(root)).canvas;
    expect(graph.edges).toHaveLength(0);
    const images = projectCanvas(graph)
      .nodes.filter((node) => node.type === "creative" && node.data.uploaded)
      .sort((left, right) => left.data.label.localeCompare(right.data.label));
    const positions = images.map((node) => node.position);
    expect(positions).toHaveLength(4);
    const [first, second, third, fourth] = positions;
    if (!first) throw new Error("首个上传节点缺失");
    expect(second).toEqual({ x: first.x + 440, y: first.y });
    expect(third).toEqual({ x: first.x + 880, y: first.y });
    expect(fourth).toEqual({ x: first.x, y: first.y + 380 });
    await chooseCanvasZoom(page, "适应画布");
    const selectedImages = images.slice(0, 2);
    for (const [index, node] of selectedImages.entries()) {
      await page
        .locator(`.react-flow__node[data-id="${node.id}"] header strong`)
        .click({ modifiers: index === 0 ? [] : ["ControlOrMeta"] });
    }
    const assetCopies = [join(root, "保存一.png"), join(root, "保存二.png")];
    await application.evaluate(({ dialog }, destinations) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: destinations.shift(),
      })) as typeof dialog.showSaveDialog;
    }, assetCopies);
    await page
      .getByRole("toolbar", { name: "多选节点操作" })
      .getByRole("button", { name: "下载素材" })
      .click();
    const state = await latestSnapshot(root);
    for (const [index, node] of selectedImages.entries()) {
      if (node.type !== "creative" || !node.data.assetId) throw new Error("缺少下载来源");
      const asset = state.assets[node.data.assetId];
      if (!asset) throw new Error("素材记录缺失");
      const expected = await readFile(join(root, asset.displayName));
      await expect
        .poll(async () =>
          (await readFile(assetCopies[index] as string).catch(() => Buffer.alloc(0))).equals(
            expected,
          ),
        )
        .toBe(true);
    }
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^素材来源线/ }).click();
    await expect(reopened.locator(".react-flow__node")).toHaveCount(5);
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(0);
    await expect(reopened.locator(".react-flow__handle-left:visible")).toHaveCount(1);
    await chooseCanvasZoom(reopened, "适应画布");
    const material = selectedImages[0]!;
    await reopened
      .locator(`[data-id="${material.id}"] .react-flow__handle-right`)
      .dragTo(reopened.locator(`[data-id="${id}"] .react-flow__handle-left`));
    await expect
      .poll(async () => (await latestSnapshot(root)).canvas.edges)
      .toEqual([expect.objectContaining({ source: material.id, target: id })]);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("画布上传在原节点重试，重开失败项不能重试，删除处理中节点不复活", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-canvas-uploads-"));
  const bad = join(root, "可修复.png"),
    other = join(root, "一直失败.png"),
    rejected = join(root, "文档.txt");
  const portrait = join(root, "竖图.png");
  let app = await launchCanvas(root);
  try {
    const page = await app.firstWindow();
    const png = Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 16;
        return canvas.toDataURL().split(",")[1]!;
      }),
      "base64",
    );
    await Promise.all([
      writeFile(rejected, "no"),
      writeFile(bad, "broken"),
      writeFile(other, "broken"),
      writeFile(portrait, png),
    ]);
    await createCanvasProject(page, "上传节点生命周期");
    await chooseCanvasFiles(
      page,
      page.getByRole("button", { name: /^上传素材 图片、视频、音频/ }),
      [rejected, bad, other, portrait],
    );
    const cards = page.locator(".react-flow__node");
    await expect(cards).toHaveCount(3);
    const failed = cards.filter({ has: page.getByText("可修复", { exact: true }) });
    await expect(failed.getByRole("button", { name: "重试" })).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "只收图片、视频和音频，换个文件试试" }),
    ).toBeVisible();
    const snapshot = async () =>
      projectCanvas((await latestSnapshot(root)).canvas)
        .nodes.filter((node) => node.type === "creative")
        .sort((left, right) => left.position.x - right.position.x);
    await expect
      .poll(async () =>
        (await snapshot()).map((node) => node.data.uploadFailed ?? !!node.data.assetId),
      )
      .toEqual([true, true, true]);
    const before = await snapshot();
    expect(before[1]!.position.x - before[0]!.position.x).toBe(440);
    expect(before[2]!.position.y).toBe(before[0]!.position.y);
    expect(before[2]!.data.mediaAspect).toBe(0.5);
    await writeFile(bad, png);
    await holdCanvasFile(app, "sync");
    await failed.getByRole("button", { name: "重试" }).click();
    const processing = failed.getByRole("status");
    await expect(processing).toContainText("处理中");
    await expect(processing).toContainText("文件已传完，正在保存");
    await expect(failed.getByRole("button", { name: "取消" })).toHaveCount(0);
    await releaseCanvasFile(app);
    await expect.poll(async () => (await snapshot())[0]?.data.assetId).toBeTruthy();
    const repaired = (await snapshot())[0]!;
    expect(repaired.id).toBe(before[0]!.id);
    expect(repaired.position).toEqual(before[0]!.position);
    expect(repaired.data.uploadFailed).toBeUndefined();
    const assets = (await latestSnapshot(root)).assets;
    expect(repaired.data.assetId).not.toBe(before[2]!.data.assetId);
    expect(assets[repaired.data.assetId!]!.sha256).toBe(assets[before[2]!.data.assetId!]!.sha256);
    expect(assets[repaired.data.assetId!]!.storage).toEqual(
      assets[before[2]!.data.assetId!]!.storage,
    );
    await app.close();
    app = await launchCanvas(root);
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: /^上传节点生命周期/ }).click();
    const stale = reopened.locator(`[data-id="${before[1]!.id}"]`);
    await expect(stale.getByRole("alert")).toHaveText("上传失败，请重试");
    await expect(stale.getByRole("button", { name: "重试" })).toHaveCount(0);
    await holdCanvasFile(app, "sync");
    await reopened.getByRole("button", { name: "添加节点", exact: true }).click();
    await chooseCanvasFiles(reopened, reopened.getByRole("menuitem", { name: "上传素材" }), [
      portrait,
    ]);
    const pending = reopened
      .locator(".react-flow__node")
      .filter({ has: reopened.getByRole("status").filter({ hasText: "处理中" }) });
    await expect(pending).toHaveCount(1);
    const pendingId = await pending.getAttribute("data-id");
    await expect(pending.locator("article")).toHaveCSS("height", "648px");
    await expect(reopened.getByText("竖图.png 已存在", { exact: true })).toHaveCount(0);
    expect(await snapshot()).toHaveLength(3);
    await pending.focus();
    await reopened.keyboard.press("Backspace");
    await expect(pending).toHaveCount(0);
    await releaseCanvasFile(app);
    await expect(reopened.getByRole("group", { name: "处理重复素材" })).toHaveCount(0);
    await expect(reopened.locator(".react-flow__node")).toHaveCount(3);
    expect(Object.keys((await latestSnapshot(root)).assets)).toHaveLength(2);
    await reopened.getByRole("button", { name: "撤销", exact: true }).click();
    const shell = reopened.locator(`[data-id="${pendingId}"]`);
    await expect(shell.getByRole("alert")).toHaveText("上传已中断，请删除后重新上传");
    await expect(shell.getByRole("button", { name: "重试" })).toHaveCount(0);
    await expect(shell.getByText("上传失败", { exact: true })).toBeVisible();
    await expect(reopened.getByRole("group", { name: "处理重复素材" })).toHaveCount(0);
    await reopened.getByRole("button", { name: "重做", exact: true }).click();
    await expect(shell).toHaveCount(0);
    await reopened.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(shell.getByRole("alert")).toBeVisible();
    await app.close();
    app = await launchCanvas(root, portrait);
    const fresh = await app.firstWindow();
    await fresh.getByRole("button", { name: /^上传节点生命周期/ }).click();
    await expect(fresh.locator(".react-flow__node")).toHaveCount(3);
    await expect(fresh.locator(`[data-id="${pendingId}"]`)).toHaveCount(0);
    expect(Object.keys((await latestSnapshot(root)).assets)).toHaveLength(2);
  } finally {
    await releaseCanvasFile(app).catch(() => {});
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("选择旋转和非方形像素的视频，首次落位、处理、入库与重开均为显示画幅", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-display-aspect-"));
  let app = await launchCanvas(root);
  try {
    const ffmpeg = join(
      process.cwd(),
      "out/media",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    const encode =
      process.platform === "darwin"
        ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
        : ["-c:v", "libx264"];
    const wide = join(root, "基准.mp4"),
      rotated = join(root, "旋转.mp4"),
      anamorphic = join(root, "宽像素.mp4");
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=128x64",
      "-frames:v",
      "2",
      ...encode,
      wide,
    ]);
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-display_rotation",
      "90",
      "-i",
      wide,
      "-c",
      "copy",
      rotated,
    ]);
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=64x64",
      "-vf",
      "setsar=2/1",
      "-frames:v",
      "2",
      ...encode,
      anamorphic,
    ]);
    const page = await app.firstWindow();
    await createCanvasProject(page, "显示画幅");
    const initial = page.evaluate(
      () =>
        new Promise<Record<string, string[]>>((resolve) => {
          const observed: Record<string, string[]> = {};
          const observer = new MutationObserver(() => {
            const cards = Array.from(
              document.querySelectorAll<HTMLElement>(
                "article:has(.canvas-upload-body [role=status])",
              ),
            );
            for (const card of cards) {
              const label = card.querySelector("header strong")?.textContent;
              if (label && !observed[label])
                observed[label] = [getComputedStyle(card).width, getComputedStyle(card).height];
            }
            if (Object.keys(observed).length === 2) {
              observer.disconnect();
              resolve(observed);
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }),
    );
    await chooseCanvasFiles(
      page,
      page.getByRole("button", { name: /^上传素材 图片、视频、音频/ }),
      [rotated, anamorphic],
    );
    const frames = { 旋转: ["324px", "648px"], 宽像素: ["648px", "324px"] };
    expect(await initial).toEqual(frames);
    const dims = (frame: Page) =>
      frame
        .locator(".react-flow__node article")
        .evaluateAll((cards) =>
          Object.fromEntries(
            cards.map((card) => [
              card.querySelector("header strong")?.textContent,
              [getComputedStyle(card).width, getComputedStyle(card).height],
            ]),
          ),
        );
    await expect
      .poll(async () => {
        const state = await latestSnapshot(root);
        return projectCanvas(state.canvas)
          .nodes.sort((left, right) => left.position.x - right.position.x)
          .flatMap((node) =>
            node.type === "creative" && node.data.assetId
              ? [[node.data.mediaAspect, state.assets[node.data.assetId]?.metadata.displayAspect]]
              : [],
          );
      })
      .toEqual([
        [0.5, 0.5],
        [2, 2],
      ]);
    await expect.poll(() => dims(page)).toEqual(frames);
    await holdCanvasFile(app, "sync");
    await page.getByRole("button", { name: "添加节点", exact: true }).click();
    await chooseCanvasFiles(page, page.getByRole("menuitem", { name: "上传素材" }), [rotated]);
    const pending = page
      .locator("article")
      .filter({ has: page.getByRole("status").filter({ hasText: "处理中" }) });
    await expect(pending).toHaveCSS("width", "324px");
    await expect(pending).toHaveCSS("height", "648px");
    await releaseCanvasFile(app);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.nodes.length).toBe(3);
    await app.close();
    app = await launchCanvas(root);
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: /^显示画幅/ }).click();
    await expect.poll(() => dims(reopened)).toEqual({ ...frames, "旋转 2": frames["旋转"] });
  } finally {
    await releaseCanvasFile(app).catch(() => {});
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("视频拷贝到四分之一时拒绝拖线和覆盖，上传完成可用同一端口建线", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-copy-port-"));
  const app = await launchCanvas(root);
  const release = () => releaseCanvasFile(app);
  try {
    const page = await app.firstWindow(),
      video = join(root, "在传.mp4"),
      photo = join(root, "新图.png");
    const ffmpeg = join(
      process.cwd(),
      "out/media",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    const encode =
      process.platform === "darwin"
        ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
        : ["-c:v", "libx264"];
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=64x64",
      "-frames:v",
      "2",
      ...encode,
      video,
    ]);
    await runMediaProcess(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=64x32",
      "-frames:v",
      "1",
      photo,
    ]);
    const mp4 = await readFile(video),
      padding = Buffer.alloc(4 * 1024 * 1024 - mp4.length);
    padding.writeUInt32BE(padding.length);
    padding.write("free", 4);
    await writeFile(video, Buffer.concat([mp4, padding]));
    await createCanvasProject(page);
    await holdCanvasFile(app, "secondChunk");
    await chooseCanvasFiles(
      page,
      page.getByRole("button", { name: /^上传素材 图片、视频、音频/ }),
      [video],
    );
    const source = page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("在传", { exact: true }) });
    await expect(source.getByRole("status")).toContainText("25%");
    const pane = page.locator(".react-flow__pane"),
      bounds = await pane.boundingBox();
    if (!bounds) throw Error("画布不可见");
    await page.mouse.dblclick(bounds.x + bounds.width - 55, bounds.y + bounds.height * 0.52);
    const menu = page.getByRole("menu", { name: /^(画布菜单|添加节点)$/ });
    await menu.getByRole("menuitem", { name: "视频生成", exact: true }).click();
    const target = page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("视频", { exact: true }) })
      .locator("article");
    await chooseCanvasZoom(page, "适应画布");
    await expect(target).toBeVisible();
    const port = source.locator(".react-flow__handle-right");
    const drag = async () => {
      await port.hover();
      const box = await target.boundingBox();
      if (!box) throw Error("缺少连线目标");
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.4, { steps: 12 });
    };
    await drag();
    try {
      await expect(target).toHaveCSS("opacity", "0.35");
      await expect(target).toHaveCSS("transform", "none");
      await page.screenshot({ path: "test-results/canvas-file-aspect/copying-link.png" });
    } finally {
      await page.mouse.up();
    }
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "视频生成", exact: true })).toBeDisabled();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await page.keyboard.press("Escape");
    const frame = await source.boundingBox();
    if (!frame) throw Error("缺少上传节点");
    const session = await page.context().newCDPSession(page);
    const drop = {
      x: frame.x + frame.width / 2,
      y: frame.y + frame.height / 2,
      data: { items: [], files: [photo], dragOperationsMask: 1 },
    };
    try {
      for (const type of ["dragEnter", "dragOver", "drop"] as const)
        await session.send("Input.dispatchDragEvent", { type, ...drop });
    } finally {
      await session.detach();
    }
    await expect(
      page.locator(".react-flow__node").filter({ has: page.getByText("新图", { exact: true }) }),
    ).toHaveCount(1);
    await expect(source.getByRole("status")).toContainText("25%");
    await release();
    await expect(source.locator(".canvas-upload-body")).toHaveCount(0);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.nodes.length).toBe(3);
    const extra = page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("新图", { exact: true }) });
    await extra.focus();
    await page.keyboard.press("Backspace");
    await expect(extra).toHaveCount(0);
    await chooseCanvasZoom(page, "适应画布");
    await port.dragTo(target.locator(".react-flow__handle-left"));
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges.length).toBe(1);
    await target.locator("header strong").click();
    const reference = page.getByRole("button", { name: "引用：在传，点击定位到节点" });
    const poster = reference.locator("img");
    await expect(poster).toHaveJSProperty("naturalWidth", 64);
    await expect(poster).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(page.locator("video")).toHaveCount(0);
    await reference.hover();
    const preview = page.locator(".canvas-ref-peek video");
    await expect(preview).toHaveAttribute("src", /^link-media:/);
    await expect(preview).toHaveJSProperty("videoWidth", 64);
    await expect(preview).toHaveJSProperty("paused", false);
    await expect(preview).toHaveJSProperty("loop", true);
    await expect(preview).toHaveJSProperty("muted", true);
    await page.mouse.move(1, 1);
    await expect(preview).toHaveCount(0);
    await expect(poster).toHaveJSProperty("naturalWidth", 64);
    await page.getByRole("button", { name: "断开「在传」的引用" }).click();
    await expect(reference).toHaveCount(0);
    await page.getByRole("button", { name: "引用画布里的素材" }).click();
    const choice = page.getByRole("menuitem", { name: "在传", exact: true });
    await expect(choice.locator("img")).toHaveJSProperty("naturalWidth", 64);
    await expect(choice.locator("video")).toHaveCount(0);
    await choice.click();
    await expect(reference.locator("img")).toHaveJSProperty("naturalWidth", 64);
    const prompt = page.getByRole("textbox", { name: "生成提示词" });
    await prompt.click();
    await page.keyboard.insertText("@");
    const option = page.getByRole("option", { name: "在传", exact: true });
    await expect(option.locator("img")).toHaveJSProperty("naturalWidth", 64);
    await prompt.press("Enter");
    const chip = prompt.locator("[data-ref]");
    await expect(chip.locator("img")).toHaveJSProperty("naturalWidth", 64);
    await expect(chip.locator("video")).toHaveCount(0);
    await chip.hover();
    await expect(preview).toHaveJSProperty("videoWidth", 64);
  } finally {
    await release().catch(() => {});
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("组内交叉连线按叠放顺序选中，剪断只影响一条并可撤销重开", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-crossed-group-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "交叉剪线");
    const members = ["左上", "右下", "左下", "右上"].map((label, index) => ({
      id: `image-${index}`,
      type: "canvas",
      parentId: "frame",
      position: { x: index % 2 ? 1200 : 80, y: index === 1 || index === 2 ? 700 : 80 },
      data: { kind: "image", label },
    }));
    const graph = {
      title: "交叉剪线",
      nodes: [
        {
          id: "frame",
          type: "group",
          position: { x: 100, y: 100 },
          width: 1900,
          height: 1120,
          data: { label: "剪线组" },
        },
        ...members,
      ],
      edges: [
        { id: "falling", source: "image-0", target: "image-1" },
        { id: "rising", source: "image-2", target: "image-3" },
      ],
    };
    const chooser = page.waitForEvent("filechooser");
    await projectAction(page, "导入画布");
    await (await chooser).setFiles({
      name: "crossed.canvas.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ format: "video-canvas/canvas", version: 1, assets: {}, canvas: graph }),
      ),
    });
    const edges = page.locator(".react-flow__edge");
    await expect(edges).toHaveCount(2);
    await chooseCanvasZoom(page, "适应画布");
    const paths = edges.locator(".react-flow__edge-path");
    const points = () =>
      paths.evaluateAll((elements) =>
        elements.map((element) => {
          const path = element as SVGPathElement,
            matrix = path.getScreenCTM()!;
          const at = (fraction: number) => {
            const { x, y } = path
              .getPointAtLength(path.getTotalLength() * fraction)
              .matrixTransform(matrix);
            return { x, y };
          };
          return { id: path.id, middle: at(0.5), branch: at(0.25) };
        }),
      );
    await expect
      .poll(async () => {
        const before = await points();
        await page.waitForTimeout(100);
        return JSON.stringify(before) === JSON.stringify(await points());
      })
      .toBe(true);
    const [bottom, top] = await points();
    if (!bottom || !top) throw new Error("缺少交叉线");
    expect(Math.hypot(top.middle.x - bottom.middle.x, top.middle.y - bottom.middle.y)).toBeLessThan(
      1,
    );
    const button = page.getByRole("button", { name: "断开连接", exact: true });
    const click = (point: { x: number; y: number }) => page.mouse.click(point.x, point.y);
    const selected = () =>
      edges.evaluateAll((items) =>
        items
          .filter((item) => item.classList.contains("selected"))
          .map((item) => item.getAttribute("data-id"))
          .sort(),
      );
    await click(top.middle);
    await expect.poll(selected).toEqual([top.id]);
    await expect(button).toBeVisible();
    await page.keyboard.down("Shift");
    try {
      await click(bottom.branch);
    } finally {
      await page.keyboard.up("Shift");
    }
    await expect.poll(selected).toEqual([bottom.id]);
    await page.keyboard.down("ControlOrMeta");
    try {
      await click(top.branch);
    } finally {
      await page.keyboard.up("ControlOrMeta");
    }
    await expect.poll(selected).toEqual([bottom.id, top.id].sort());
    await expect(button).toBeHidden();
    await click(top.middle);
    await expect.poll(selected).toEqual([top.id]);
    const saved = async () => {
      const canvas = projectCanvas((await latestSnapshot(root)).canvas);
      const group = canvas.nodes.find(
        (node) => node.type === "group" && node.data.label === "剪线组",
      );
      const labels = new Map(canvas.nodes.map((node) => [node.id, node.data.label]));
      return {
        edges: canvas.edges
          .map((edge) => [edge.id, labels.get(edge.source), labels.get(edge.target)])
          .sort(),
        members: canvas.nodes
          .filter((node) => node.type === "creative" && group && node.parentId === group.id)
          .map((node) => node.data.label)
          .sort(),
      };
    };
    const both = {
      edges: [
        [top.id, "左下", "右上"],
        [bottom.id, "左上", "右下"],
      ].sort(),
      members: ["左上", "右下", "左下", "右上"].sort(),
    };
    await expect.poll(saved).toEqual(both);
    const cut = { ...both, edges: [[bottom.id, "左上", "右下"]] };
    await button.click();
    await expect.poll(saved).toEqual(cut);
    await click(top.middle);
    await expect.poll(selected).toEqual([bottom.id]);
    await expect
      .poll(() => page.evaluate(() => document.activeElement instanceof SVGElement))
      .toBe(true);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(saved).toEqual(both);
    await expect.poll(selected).toEqual([top.id]);
    await expect(button).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(saved).toEqual(cut);
    await expect.poll(selected).toEqual([bottom.id]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(saved).toEqual(both);
    await expect.poll(selected).toEqual([top.id]);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^交叉剪线/ }).click();
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(2);
    await expect.poll(saved).toEqual(both);
    await expect(reopened.locator(".react-flow__edge.selected")).toHaveCount(0);
    await expect(reopened.getByRole("button", { name: "断开连接", exact: true })).toHaveCount(0);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 核心画布编辑、分组、历史和关闭恢复", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "link-studio-canvas-e2e-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page, "核心画布验收");
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "项目文件" })).toBeHidden();
    await expect(page.getByRole("region", { name: "画布小灵" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "从一个节点开始" })).toBeVisible();
    await page.screenshot({ path: "test-results/canvas-empty.png" });
    await page.getByRole("button", { name: /^文本 脚本、分镜描述/ }).click();
    const script = page.getByRole("region", { name: "文本内容", exact: true });
    const sourceNode = page.locator(".react-flow__node").filter({ has: script });
    const scriptId = await sourceNode.getAttribute("data-id");
    const editableTitle = page.locator(`.react-flow__node[data-id="${scriptId}"] header strong`);
    const card = sourceNode.locator("article");
    await expect(card).toHaveAccessibleName("文本");
    const titleLayout = await card.evaluate((el: HTMLElement) => {
      const heading = el.querySelector("header")!.getBoundingClientRect();
      const frame = el.getBoundingClientRect();
      const zoom = frame.width / el.offsetWidth;
      return {
        width: el.offsetWidth,
        height: el.offsetHeight,
        gap: Math.round((frame.top - heading.bottom) / zoom),
        left: Math.round((heading.left - frame.left) / zoom),
      };
    });
    expect(titleLayout).toEqual({ width: 576, height: 324, gap: 8, left: 2 });
    await sourceNode.getByRole("button", { name: "重命名节点：文本", exact: true }).press("Enter");
    const nameField = page.getByRole("textbox", { name: "节点名称", exact: true });
    await expect(nameField).toBeFocused();
    expect(
      await nameField.evaluate((field: HTMLInputElement) => [
        field.selectionStart,
        field.selectionEnd,
      ]),
    ).toEqual([0, 2]);
    await nameField.fill("不保存的草稿");
    await nameField.press("Escape");
    await expect(editableTitle).toHaveText("文本");
    await editableTitle.dblclick();
    await nameField.fill("   测试    标题   ");
    await nameField.press("Tab");
    await expect(editableTitle).toHaveText("测试 标题");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(editableTitle).toHaveText("文本");
    await expect(page.getByRole("heading", { name: "从一个节点开始" })).toBeHidden();
    await editTextNode(script, "第一版", "第二版");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(script).toHaveText("双击输入文字");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(script).toHaveText("第二版");
    const startingWidth = (await card.boundingBox())!.width;
    await chooseCanvasZoom(page, "缩小");
    await expect
      .poll(() => card.evaluate((el) => el.getBoundingClientRect().width))
      .toBeCloseTo(startingWidth / 1.2, 0);
    const pane = page.locator(".react-flow__pane");
    const paneBounds = await pane.boundingBox();
    if (!paneBounds) throw new Error("画布不可见");
    const textFrame = (await card.boundingBox())!;
    const clickPoint = {
      x: Math.round(textFrame.x + textFrame.width + 96),
      y: Math.round(paneBounds.y + 140),
    };
    const addMenu = page.getByRole("menu", { name: /^(画布菜单|添加节点)$/ });
    await page.getByRole("radio", { name: "抓手" }).click();
    await page.mouse.move(clickPoint.x, clickPoint.y);
    await page.mouse.down();
    await page.mouse.move(clickPoint.x - 80, clickPoint.y + 12, { steps: 6 });
    await page.mouse.up();
    await expect(addMenu).toBeHidden();
    await page.getByRole("radio", { name: "选择", exact: true }).click();
    await page.mouse.click(clickPoint.x, clickPoint.y);
    await expect(addMenu).toBeHidden();
    await page.mouse.click(clickPoint.x, clickPoint.y);
    await expect(addMenu).toBeHidden();
    await page.mouse.dblclick(clickPoint.x, clickPoint.y);
    await expect(addMenu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(addMenu).toBeHidden();
    await page.mouse.dblclick(clickPoint.x, clickPoint.y);
    await expect(addMenu).toBeVisible();
    await addMenu.getByRole("menuitem", { name: "图片生成", exact: true }).click();
    const imageNode = page
      .locator(".react-flow__node")
      .filter({ has: page.locator("header strong").filter({ hasText: /^图片$/ }) });
    await expect(imageNode).toBeVisible();
    const imageBounds = await imageNode.boundingBox();
    expect(imageBounds?.x).toBeCloseTo(clickPoint.x, 0);
    expect(imageBounds?.y).toBeCloseTo(clickPoint.y, 0);
    const sourceHandle = sourceNode.locator(".react-flow__handle-right");
    await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
    if (!imageBounds) throw new Error("缺少图片节点尺寸");
    await sourceHandle.hover();
    await page.mouse.down();
    try {
      await page.mouse.move(
        imageBounds.x + imageBounds.width / 4,
        imageBounds.y + imageBounds.height / 4,
        { steps: 12 },
      );
      await expect
        .poll(() => imageNode.locator("article").evaluate((card) => card.style.transform))
        .toContain("rotateY");
    } finally {
      await page.mouse.up();
    }
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(imageNode.locator("article")).toHaveCSS("transform", "none");
    const drawnEdge = page.locator(".react-flow__edge").first();
    await expect(drawnEdge.locator("animateTransform")).toHaveAttribute("dur", "2.6s");
    const edgePoint = await drawnEdge.locator(".react-flow__edge-path").evaluate((element) => {
      const path = element as SVGPathElement;
      const matrix = path.getScreenCTM();
      if (!matrix) throw new Error("无法读取连线变换");
      for (const ratio of [0.28, 0.72, 0.36, 0.64, 0.2, 0.8]) {
        const hit = path.getPointAtLength(ratio * path.getTotalLength()).matrixTransform(matrix);
        if (document.elementFromPoint(hit.x, hit.y)?.closest(".react-flow__edge"))
          return { x: hit.x, y: hit.y };
      }
      throw new Error("缺少可操作的连线区域");
    });
    await page.mouse.click(edgePoint.x, edgePoint.y);
    const scissors = page.getByRole("button", { name: "断开连接", exact: true });
    await expect(scissors).toBeVisible();
    const scissorsBox = await scissors.boundingBox();
    if (!scissorsBox) throw new Error("剪刀不可见");
    expect(
      Math.hypot(
        scissorsBox.x + scissorsBox.width / 2 - edgePoint.x,
        scissorsBox.y + scissorsBox.height / 2 - edgePoint.y,
      ),
    ).toBeLessThan(2);
    await scissors.click();
    await expect(drawnEdge).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(drawnEdge).toHaveCount(1);
    await sourceNode.locator("header strong").click();
    await imageNode.locator("header strong").click({ modifiers: ["Shift"] });
    const selection = page.getByRole("toolbar", { name: "多选节点操作" });
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
    await expect(imageNode).toHaveClass(/selected/);
    await expect(selection).toBeHidden();
    await sourceNode.locator("header strong").click({ modifiers: ["ControlOrMeta"] });
    const assertSelectionSpacing = async () => {
      await expect
        .poll(async () => {
          const [frame, tools] = await Promise.all([
            page.locator(".canvas-selection-frame").boundingBox(),
            selection.boundingBox(),
          ]);
          return frame && tools ? Math.abs(frame.y - tools.y - tools.height - 14) : Infinity;
        })
        .toBeLessThan(1);
    };
    await assertSelectionSpacing();
    const beforeLayout = (await latestSnapshot(root)).canvas.nodes;
    const layoutTrigger = selection.getByRole("button", { name: "整理布局" });
    await layoutTrigger.press("ArrowDown");
    const arrangeMenu = page.getByRole("menu", { name: "整理布局" });
    await expect(arrangeMenu.getByRole("menuitem")).toHaveText([
      "横向排列",
      "纵向排列",
      "网格排列",
    ]);
    await expect(arrangeMenu.getByRole("menuitem", { name: "横向排列" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(layoutTrigger).toBeFocused();
    await layoutTrigger.click();
    const columnFrames = await sampleArrangement(
      arrangeMenu.getByRole("menuitem", { name: "纵向排列" }),
    );
    expect(new Set(columnFrames.map((sample) => sample.nodes)).size).toBeGreaterThan(2);
    expect(new Set(columnFrames.map((sample) => sample.edge)).size).toBeGreaterThan(2);
    await expect
      .poll(async () => {
        const positions = (await latestSnapshot(root)).canvas.nodes.map(
          (node) => (node as { position: { x: number } }).position.x,
        );
        return new Set(positions).size;
      })
      .toBe(1);
    await selection.getByRole("button", { name: "复制选中节点" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(2);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.nodes).toEqual(beforeLayout);
    await expect(sourceNode).toHaveClass(/selected/);
    await expect(imageNode).toHaveClass(/selected/);
    await selection.getByRole("button", { name: "删除选中节点" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(sourceNode).toHaveClass(/selected/);
    await expect(imageNode).toHaveClass(/selected/);
    await page.getByRole("button", { name: "打组", exact: true }).click();
    const group = page.locator(".canvas-group");
    const groupName = group.getByRole("textbox", { name: "组名" });
    await expect(groupName).toBeFocused();
    await expect(groupName).toHaveValue("组");
    await groupName.fill("分组草稿");
    await groupName.press("Escape");
    await expect(group).toHaveText("组");
    await page.keyboard.press("F2");
    await expect(groupName).toBeFocused();
    await groupName.fill("   场景    一   ");
    await groupName.press("Enter");
    await expect(group).toHaveText("场景 一");
    await group.locator(".canvas-group-name svg").dblclick();
    await expect(groupName).toBeFocused();
    expect(
      await groupName.evaluate((field: HTMLInputElement) => [
        field.selectionStart,
        field.selectionEnd,
      ]),
    ).toEqual([0, 4]);
    await groupName.fill("取消这一稿");
    await groupName.press("Escape");
    await expect(group).toHaveText("场景 一");
    const corner = group.locator(".group-resize-corner.top.left");
    await expect(corner).toBeVisible();
    const beforeFrame = await group.boundingBox();
    const beforeChild = await sourceNode.boundingBox();
    const grip = await corner.boundingBox();
    if (!beforeFrame || !beforeChild || !grip) throw new Error("缺少组框边界");
    const origin = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    await page.mouse.move(origin.x - 28, origin.y - 18, { steps: 6 });
    await expect(page.getByRole("button", { name: "颜色", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "引用选中的节点生成" })).toBeVisible();
    await page.mouse.up();
    await expect
      .poll(async () => (await group.boundingBox())?.width ?? 0)
      .toBeGreaterThan(beforeFrame.width + 20);
    expect((await sourceNode.boundingBox())?.x).toBeCloseTo(beforeChild.x, 0);
    expect((await sourceNode.boundingBox())?.y).toBeCloseTo(beforeChild.y, 0);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await group.boundingBox())?.width).toBe(beforeFrame.width);
    const groupShell = page.locator(".react-flow__node-group");
    const idOfGroup = await groupShell.getAttribute("data-id");
    const savedMember = async () => {
      const member = projectCanvas((await latestSnapshot(root)).canvas).nodes.find(
        ({ id }) => id === scriptId,
      );
      if (member?.type !== "creative") throw new Error("未找到文本成员");
      return member;
    };
    await expect.poll(async () => (await savedMember())?.parentId).toBe(idOfGroup);
    const memberBeforeDrop = await savedMember();
    const header = await editableTitle.boundingBox();
    if (!header || !memberBeforeDrop) throw new Error("未找到待拖动的组成员");
    const start = { x: header.x + header.width / 2, y: header.y + header.height / 2 };
    const center = {
      x: beforeChild.x + beforeChild.width / 2,
      y: beforeChild.y + beforeChild.height / 2,
    };
    const candidates = [
      { x: beforeFrame.x - center.x - 60, y: 0 },
      { x: beforeFrame.x + beforeFrame.width - center.x + 60, y: 0 },
      { x: 0, y: beforeFrame.y - center.y - 60 },
      { x: 0, y: beforeFrame.y + beforeFrame.height - center.y + 60 },
    ];
    const offset = candidates.find(
      ({ x, y }) =>
        start.x + x > paneBounds.x + 50 &&
        start.x + x < paneBounds.x + paneBounds.width - 50 &&
        start.y + y > paneBounds.y + 50 &&
        start.y + y < paneBounds.y + paneBounds.height - 50,
    );
    if (!offset) throw new Error("视口空间不足以拖出组");
    for (const returning of [false, true]) {
      const currentTitle = await editableTitle.boundingBox();
      if (!currentTitle) throw new Error("拖放前未找到成员标题");
      const from = {
        x: currentTitle.x + currentTitle.width / 2,
        y: currentTitle.y + currentTitle.height / 2,
      };
      expect(
        await editableTitle.evaluate(
          (el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
          from,
        ),
      ).toBe(true);
      const to = returning ? start : { x: start.x + offset.x, y: start.y + offset.y };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 });
      const highlighted = await page.locator(".react-flow__node-group[data-drop-target]").count();
      const beforeRelease = await sourceNode.boundingBox();
      await page.mouse.up();
      expect(highlighted).toBe(returning ? 1 : 0);
      await expect
        .poll(async () => (await savedMember())?.parentId)
        .toBe(returning ? idOfGroup : undefined);
      await expect(page.locator(".react-flow__node-group[data-drop-target]")).toHaveCount(0);
      const afterRelease = await sourceNode.boundingBox();
      if (!beforeRelease || !afterRelease) throw new Error("拖动后节点丢失");
      expect(afterRelease.x).toBeCloseTo(beforeRelease.x, 0);
      expect(afterRelease.y).toBeCloseTo(beforeRelease.y, 0);
      expect((await latestSnapshot(root)).canvas.edges).toHaveLength(1);
    }
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await savedMember())?.parentId).toBeUndefined();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(savedMember).toEqual(memberBeforeDrop);
    await editableTitle.click();
    await imageNode.locator("header strong").click({ modifiers: ["ControlOrMeta"] });
    const beforeRegroup = await sourceNode.boundingBox();
    await selection.getByRole("button", { name: "打组", exact: true }).click();
    await expect(group).toHaveCount(2);
    await group.getByRole("textbox", { name: "组名" }).press("Enter");
    await expect.poll(async () => (await savedMember()).parentId).not.toBe(idOfGroup);
    const regrouped = projectCanvas((await latestSnapshot(root)).canvas);
    const nextGroup = regrouped.nodes.find(
      (node) => node.type === "group" && node.id !== idOfGroup,
    );
    expect(nextGroup).toBeDefined();
    expect(
      regrouped.nodes.filter((node) => node.type === "creative" && node.parentId === nextGroup?.id),
    ).toHaveLength(2);
    expect(regrouped.edges).toHaveLength(1);
    expect(await sourceNode.boundingBox()).toEqual(beforeRegroup);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(group).toHaveCount(1);
    await expect.poll(savedMember).toEqual(memberBeforeDrop);
    await group.locator("svg").click();
    const groupTools = page.getByRole("toolbar", { name: "分组操作" });
    await expect(groupTools).toBeHidden();
    await group.locator("svg").click();
    await chooseCanvasZoom(page, "适应画布");
    await expect(groupTools.getByRole("button")).toHaveCount(4);
    await expect(groupTools).toHaveCSS("height", "52px");
    const referenceHandle = page.getByRole("button", { name: "引用选中的节点生成", exact: true });
    await editableTitle.click();
    await imageNode.locator("header strong").click({ modifiers: ["ControlOrMeta"] });
    await referenceHandle.click();
    await expect(addMenu.getByRole("menuitem", { name: "文本", exact: true })).toBeDisabled();
    await addMenu.getByRole("menuitem", { name: "分镜表", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "分镜表" })).toHaveCount(0);
    await expect(
      page
        .locator("[data-sonner-toast][data-type=info]")
        .getByText("1 个节点接不到分镜表上，已跳过", { exact: true }),
    ).toBeVisible();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(2);
    const mixed = projectCanvas((await latestSnapshot(root)).canvas);
    const storyboard = mixed.nodes.find((node) => node.type === "creative" && node.data.storyboard);
    expect(mixed.edges.filter((edge) => edge.target === storyboard?.id)).toEqual([
      expect.objectContaining({ source: scriptId }),
    ]);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await group.locator("svg").click();
    await referenceHandle.click();
    await expect(addMenu).toContainText("引用选中的 2 个节点生成");
    await expect(addMenu.getByRole("menuitem", { name: "上传素材" })).toBeDisabled();
    await expect(addMenu.getByRole("menuitem", { name: "从资产库添加" })).toBeVisible();
    await expect(page.locator(".canvas-fan-lines path")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.locator(".canvas-fan-lines")).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    const handleBox = await referenceHandle.boundingBox();
    if (!handleBox) throw new Error("找不到组引用把手");
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 120, handleBox.y + 70, { steps: 8 });
    const drawnLines = await page.locator(".canvas-fan-lines path").count();
    await page.mouse.up();
    expect(drawnLines).toBe(2);
    await expect(page.locator(".canvas-fan-lines path")).toHaveCount(2);
    await addMenu.getByRole("menuitem", { name: "视频生成", exact: true }).click();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(3);
    const referenced = projectCanvas((await latestSnapshot(root)).canvas);
    const downstream = referenced.nodes.find(
      (node) => node.type === "creative" && node.data.kind === "video",
    );
    expect(
      referenced.edges
        .filter((edge) => edge.target === downstream?.id)
        .map((edge) => edge.source)
        .sort(),
    ).toEqual(
      referenced.nodes
        .filter((node) => node.type === "creative" && node.parentId === idOfGroup)
        .map((node) => node.id)
        .sort(),
    );
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await group.locator("svg").click();
    const gridFrames = await sampleArrangement(
      groupTools.getByRole("button", { name: "整理布局", exact: true }),
    );
    expect(new Set(gridFrames.map((sample) => sample.nodes)).size).toBeGreaterThan(2);
    expect(new Set(gridFrames.map((sample) => sample.frame)).size).toBe(2);
    expect(
      gridFrames
        .filter((sample) => sample.frame !== gridFrames[0]?.frame)
        .every((sample) => sample.nodes === gridFrames.at(-1)?.nodes),
    ).toBe(true);
    await expect
      .poll(async () => {
        const graph = projectCanvas((await latestSnapshot(root)).canvas);
        const members = graph.nodes.filter((node) => node.type === "creative" && node.parentId);
        return (
          members.length === 2 &&
          members.every((member) => member.position.y === 72) &&
          Math.min(...members.map((member) => member.position.x)) === 48
        );
      })
      .toBe(true);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(savedMember).toEqual(memberBeforeDrop);
    await group.locator(".canvas-group-name span").dblclick();
    await groupName.fill("镜头一");
    await groupName.press("Enter");
    await expect(group).toHaveText("镜头一");
    await group.locator("svg").click();
    await page.getByRole("button", { name: "颜色", exact: true }).click();
    const background = page.getByRole("region", { name: "背景颜色" });
    await expect(background.getByRole("button")).toHaveCount(9);
    await background.getByRole("button", { name: "背景颜色：蓝" }).click();
    await page.getByRole("button", { name: "标签颜色：红" }).click();
    await expect(background.getByRole("button", { name: "背景颜色：蓝" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Escape");
    await group.locator("svg").click();
    await page.keyboard.press("ControlOrMeta+d");
    await expect(group).toHaveCount(2);
    await expect(
      page.locator(".react-flow__node").getByText("镜头一 副本", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.nodes.length).toBe(6);
    const copied = (await latestSnapshot(root)).canvas;
    for (const node of projectCanvas(copied).nodes.filter((node) => node.type === "group"))
      expect(node.data).toMatchObject({ color: "blue", labelColor: "red" });
    const copy = copied.nodes.find(
      (node) => (node as { data?: { label?: string } }).data?.label === "镜头一 副本",
    ) as { id: string };
    expect(
      copied.nodes.filter((node) => (node as { parentId?: string }).parentId === copy.id),
    ).toHaveLength(2);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(group).toHaveCount(1);
    await group.locator("svg").click();
    await page.keyboard.press("ControlOrMeta+c");
    await page.keyboard.press("ControlOrMeta+v");
    await expect(group).toHaveCount(2);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(group).toHaveCount(1);
    await drag(page, group.locator("svg"), { x: 28, y: 22 });
    await expect(groupTools).toBeHidden();
    await group.locator("svg").click();
    await page.getByRole("button", { name: "解组", exact: true }).click();
    await expect(group).toHaveCount(0);
    await assertSelectionSpacing();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(group).toHaveText("镜头一");
    const zoomBeforeClick = (await latestSnapshot(root)).canvas.viewport.zoom;
    await chooseCanvasZoom(page, "缩小");
    await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(1);
    const saved = (await latestSnapshot(root)).canvas;
    expect(saved.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: scriptId, parentId: expect.any(String) }),
        expect.objectContaining({
          type: "group",
          data: { label: "镜头一", color: "blue", labelColor: "red" },
          position: expect.objectContaining({ x: expect.any(Number) }),
        }),
      ]),
    );
    await expect
      .poll(async () => (await latestSnapshot(root)).canvas.viewport.zoom)
      .toBeLessThan(zoomBeforeClick);
    expect(JSON.stringify(saved)).not.toMatch(/selected|dragging|measured|uploadProgress/);
    await editTextNode(script, "关闭前最后一笔");
    await application.close();
    expect((await latestSnapshot(root)).canvas.nodes).toContainEqual(
      expect.objectContaining({
        id: scriptId,
        data: expect.objectContaining({ text: "关闭前最后一笔" }),
      }),
    );
    application = await launchCanvas(root);
    const restored = await application.firstWindow();
    await restored.getByRole("button", { name: /^核心画布验收/ }).click();
    await expect(restored.locator(".canvas-group")).toHaveText("镜头一");
    await restored.locator(".canvas-group-name span").click();
    await restored.keyboard.press("Backspace");
    const confirmGroup = restored.getByRole("alertdialog", { name: "删除「镜头一」？" });
    await expect(confirmGroup).toContainText("里面的 2 个节点会一起被删除");
    await confirmGroup.getByRole("button", { name: "取消" }).click();
    await expect(restored.getByRole("alertdialog")).toHaveCount(0);
    await expect(restored.locator(".react-flow__node")).toHaveCount(3);
    await restored.locator(".canvas-group-name span").click();
    await restored.getByRole("button", { name: "删除组", exact: true }).click();
    await confirmGroup.getByRole("button", { name: "删除组和节点" }).click();
    await expect(restored.getByRole("alertdialog")).toHaveCount(0);
    await expect(restored.locator(".react-flow__node")).toHaveCount(0);
    await expect(restored.locator(".react-flow__edge")).toHaveCount(0);
    await restored.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(restored.locator(".react-flow__node")).toHaveCount(3);
    await expect(restored.locator(".react-flow__edge")).toHaveCount(1);
    await expect(restored.getByRole("region", { name: "文本内容", exact: true })).toHaveText(
      "关闭前最后一笔",
    );
    await expect(restored.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 磁盘写入失败保留草稿，恢复后重试保存最新编辑", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-canvas-failure-"));
  try {
    const application = await launchCanvas(root);
    try {
      const page = await application.firstWindow();
      await createCanvasProject(page);
      await page.getByRole("button", { name: /^文本 脚本、分镜描述/ }).click();
      const script = page.getByRole("region", { name: "文本内容", exact: true });
      await expect(script).toBeVisible();
      const scriptId = await script.getAttribute("data-node-id");
      await projectAction(page, "保存项目");
      await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
      const originalRevision = (await latestSnapshot(root)).canvas.revision;
      const directory = await projectDirectory(root);
      const temporary = join(directory, "tmp");
      const detached = join(directory, "tmp-detached");
      await rename(temporary, detached);
      try {
        await editTextNode(script, "写入失败时的草稿");
        await expect(page.getByText("画布保存失败，本地更改已保留")).toBeVisible();
        expect((await latestSnapshot(root)).canvas.revision).toBe(originalRevision);
        await projectAction(page, "关闭项目");
        await expect(script).toHaveText("写入失败时的草稿");
        await expect(page.getByRole("button", { name: "重试保存" })).toBeEnabled();
        await editTextNode(script, "故障期间继续改稿");
      } finally {
        await rename(detached, temporary);
      }
      await page.getByRole("button", { name: "重试保存" }).click();
      await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
      expect((await latestSnapshot(root)).canvas.nodes).toContainEqual(
        expect.objectContaining({
          id: scriptId,
          data: expect.objectContaining({ text: "故障期间继续改稿" }),
        }),
      );
    } finally {
      await application.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
