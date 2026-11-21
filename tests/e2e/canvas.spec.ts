import { once } from "node:events";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, type Locator, type Page, test } from "@playwright/test";
import type { ProjectState } from "../../packages/link-studio-core/src/project";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { addCanvasNode, projectAction } from "./workspace-actions";

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

test("图片节点宫格拆图、批量撤销与重开恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-grid-e2e-"));
  const image = join(root, "grid.png");
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
    await page.getByRole("textbox", { name: "新项目名称" }).fill("宫格验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将grid.png加入画布" }).click();
    await page.getByRole("button", { name: "关闭素材库" }).click();
    await page.getByRole("button", { name: "宫格拆图", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "宫格拆图" });
    await dialog.getByRole("button", { name: /竖分割线 1/ }).press("ArrowRight");
    await expect(dialog.getByRole("button", { name: /竖分割线 1，51%/ })).toBeVisible();
    await page.screenshot({ path: "test-results/canvas-grid-split.png" });
    await dialog.getByRole("button", { name: "拆成 4 张图片" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);
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
    await expect(reopened.locator(".react-flow__node img")).toHaveCount(5);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("图片节点涂鸦标注生成派生图片、来源连线并支持重开恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-doodle-e2e-"));
  const image = join(root, "doodle.png");
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
    await page.getByRole("textbox", { name: "新项目名称" }).fill("涂鸦验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将doodle.png加入画布" }).click();
    await page.getByRole("button", { name: "关闭素材库" }).click();
    await page.getByRole("button", { name: "涂鸦标注", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "图片涂鸦标注" });
    await expect(dialog).toBeVisible();
    const save = dialog.getByRole("button", { name: "保存为新图片" });
    await expect(save).toBeDisabled();
    await expect
      .poll(() =>
        dialog.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(3);
    const stage = dialog.getByLabel("涂鸦画布");
    const bounds = await stage.boundingBox();
    if (!bounds) throw new Error("涂鸦画布未显示");
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.65, {
      steps: 8,
    });
    await page.mouse.up();
    await dialog.getByRole("button", { name: "撤销标注" }).click();
    await expect(save).toBeDisabled();
    await dialog.getByRole("button", { name: "重做标注" }).click();
    await save.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(1);
    const snapshot = await latestSnapshot(root);
    const original = Object.values(snapshot.assets).find(
      ({ displayName }) => displayName === "doodle.png",
    );
    expect(original).toBeDefined();
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
    await expect(reopened.locator(".react-flow__node")).toHaveCount(2);
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(1);
    await expect(reopened.locator(".react-flow__node img")).toHaveCount(2);
  } finally {
    await application.close();
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
    await page.getByRole("textbox", { name: "新项目名称" }).waitFor();
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
    await page.getByRole("textbox", { name: "新项目名称" }).fill("扩图验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将outpaint.png加入画布" }).click();
    await page.getByRole("button", { name: "关闭素材库" }).click();
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
    await page.getByRole("textbox", { name: "新项目名称" }).fill("角色卡验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByRole("button", { name: "导入素材" }).click();
    await expect(page.getByRole("button", { name: "将look.png加入画布" })).toBeVisible();
    await page.getByRole("button", { name: "关闭素材库" }).click();
    await addCanvasNode(page, "角色卡");
    const character = page.getByRole("dialog", { name: "角色卡" });
    await character.getByLabel("角色名").fill("林舟");
    await character.getByLabel("形象名").fill("夜班");
    await character.getByLabel("角色设定").fill("车站的夜班值班员");
    await character.getByLabel("主图").selectOption({ label: "look.png" });
    await character.getByRole("button", { name: "保存角色" }).click();
    await expect(page.locator(".react-flow__node img")).toHaveCount(1);
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
    await reopened.getByText("林舟 · 夜班", { exact: true }).click();
    await reopened.getByRole("button", { name: "编辑角色" }).click();
    const restored = reopened.getByRole("dialog", { name: "角色卡" });
    await expect(restored.getByLabel("角色设定")).toHaveValue("车站的夜班值班员");
    await expect(restored.getByLabel("主图").locator("option:checked")).toHaveText("look.png");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("角色形象与音色联合生成，音色可独立重试、试听和手动采用", async () => {
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
    await page.getByRole("textbox", { name: "新项目名称" }).waitFor();
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
    await page.getByRole("textbox", { name: "新项目名称" }).fill("音色验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await addCanvasNode(page, "角色卡");
    const dialog = page.getByRole("dialog", { name: "角色卡" });
    await dialog.getByLabel("角色名").fill("林舟");
    await dialog.getByLabel("形象名").fill("夜班");
    await dialog.getByLabel("形象提示词").fill("夜班值班员的角色设计");
    await dialog.getByLabel("音色描述或示例台词").fill("夜班列车即将进站。");
    await dialog.getByRole("button", { name: "生成形象并生成音色", exact: true }).click();
    await expect(dialog.getByText("等待形象生成并绑定主图")).toBeVisible();
    await expect.poll(() => imageCalls).toBe(1);
    expect(prompts).toEqual([]);
    imageResult?.();
    await expect(dialog.getByText("音色 · 失败")).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByLabel("主图")).not.toHaveValue("");
    await dialog.getByRole("button", { name: "重试生成音色", exact: true }).click();
    const history = dialog.getByRole("list", { name: "音色历史" });
    await expect(history).toBeVisible({ timeout: 15_000 });
    expect(prompts).toEqual(["夜班列车即将进站。", "夜班列车即将进站。"]);
    expect(references).toEqual([[{ image_data: imageBase64 }], [{ image_data: imageBase64 }]]);
    expect(imageCalls).toBe(1);
    await expect(dialog.getByRole("combobox", { name: "音色", exact: true })).toHaveValue("");
    await history.getByRole("button", { name: "试听" }).click();
    const preview = page.getByRole("dialog", { name: /^生成-/ });
    await expect(preview.locator("audio")).toBeVisible();
    await preview.getByRole("button", { name: "关闭预览" }).click();
    await history.getByRole("button", { name: "采用音色" }).click();
    const adopted = await dialog.getByRole("combobox", { name: "音色", exact: true }).inputValue();
    expect(adopted).not.toBe("");
    await dialog.getByRole("button", { name: "保存角色" }).click();
    await expect
      .poll(async () => (await latestSnapshot(root)).canvas.nodes)
      .toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            character: expect.objectContaining({ voice: { assetId: adopted } }),
          }),
        }),
      ]);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^音色验收/ }).click();
    await reopened.getByText("林舟 · 夜班", { exact: true }).click();
    await reopened.getByRole("button", { name: "编辑角色" }).click();
    const restored = reopened.getByRole("dialog", { name: "角色卡" });
    await expect(restored.getByRole("combobox", { name: "音色", exact: true })).toHaveValue(
      adopted,
    );
    await expect(restored.getByRole("button", { name: "已选音色", exact: true })).toBeVisible();
  } finally {
    await application?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("分镜表按镜头拆分，支持撤销和重开恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-storyboard-e2e-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.getByRole("textbox", { name: "新项目名称" }).fill("分镜验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 70, y: 100 } });
    await page
      .getByRole("region", { name: "添加节点菜单" })
      .getByRole("button", { name: "分镜表", exact: true })
      .click();
    const board = page.getByRole("dialog", { name: "分镜表" });
    await board.getByRole("button", { name: "添加镜头" }).click();
    await board.getByLabel("画面描述").fill("列车进站");
    await board.getByLabel("时长（秒）").fill("3.7");
    await board.getByRole("button", { name: "保存分镜" }).click();
    await page.getByRole("button", { name: "编辑分镜" }).click();
    await board.getByRole("button", { name: "拆为图片节点" }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await page.getByRole("button", { name: "编辑分镜" }).click();
    await expect(board.getByRole("button", { name: "拆为图片节点" })).toBeDisabled();
    await board.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(1);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^分镜验收/ }).click();
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(1);
    await reopened.getByText("新的分镜表", { exact: true }).click();
    await reopened.getByRole("button", { name: "编辑分镜" }).click();
    await expect(reopened.getByLabel("画面描述")).toHaveValue("列车进站");
    await expect(reopened.getByLabel("时长（秒）")).toHaveValue("3.7");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ["图片", "视频"]) {
  test(`分镜批量生成${kind}追踪逐镜状态，只重试失败镜头`, async () => {
    test.setTimeout(45_000);
    const video = kind === "视频";
    const root = await mkdtemp(join(tmpdir(), "link-studio-storyboard-jobs-"));
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=";
    const prompts: string[] = [];
    const seconds: string[] = [];
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
      if (video) seconds.push(body.seconds);
      response.setHeader("Content-Type", "application/json");
      if (prompt.startsWith("下车") && prompts.filter((text) => text === prompt).length === 1) {
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
      await page.getByRole("textbox", { name: "新项目名称" }).waitFor();
      await page.evaluate(
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
        },
        { endpoint, video },
      );
      await page.getByRole("textbox", { name: "新项目名称" }).fill("分镜任务验收");
      await page.getByRole("button", { name: "新建项目" }).click();
      await page
        .locator(".react-flow__pane")
        .click({ button: "right", position: { x: 70, y: 100 } });
      await page
        .getByRole("region", { name: "添加节点菜单" })
        .getByRole("button", { name: "分镜表", exact: true })
        .click();
      const board = page.getByRole("dialog", { name: "分镜表" });
      const first = board.getByRole("group", { name: "镜头 1", exact: true });
      const second = board.getByRole("group", { name: "镜头 2", exact: true });
      await board.getByRole("button", { name: "添加镜头" }).click();
      await first.getByLabel("画面描述").fill("进站");
      if (video) await first.getByLabel("时长（秒）").fill("4");
      await board.getByRole("button", { name: "添加镜头" }).click();
      await second.getByLabel("画面描述").fill("下车");
      await board.getByRole("button", { name: `拆为${kind}节点` }).click();
      await page.getByRole("button", { name: "编辑分镜" }).click();
      await expect(board.getByLabel("批量生成模型")).toContainText(
        video ? "agnes-video-2.5-flash" : "gpt-image-1",
      );
      if (video) {
        await expect(second.getByText("当前模型不支持此镜头时长。")).toBeVisible();
        await expect(board.getByRole("button", { name: "生成 1 个镜头" })).toBeEnabled();
        await second.getByLabel("时长（秒）").fill("6");
      }
      expect(prompts).toHaveLength(0);
      await board.getByRole("button", { name: "生成 2 个镜头" }).click();
      await expect(first.getByText("已完成", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(second.getByText("失败", { exact: true })).toBeVisible();
      await expect(first.getByRole("button", { name: "重试生成" })).toHaveCount(0);
      await second.getByRole("button", { name: "重试生成" }).click();
      await expect(second.getByText("已完成", { exact: true })).toBeVisible({ timeout: 15_000 });
      expect(prompts.map((prompt) => prompt.split("\n")[0]).sort()).toEqual([
        "下车",
        "下车",
        "进站",
      ]);
      await expect(page.locator(".react-flow__edge")).toHaveCount(2);
      if (video) {
        expect(seconds.sort()).toEqual(["4", "6", "6"]);
        expect(prompts.every((prompt) => !prompt.includes("时长："))).toBe(true);
        const snapshot = await latestSnapshot(root);
        expect(
          Object.values(snapshot.assets).filter(({ mediaType }) => mediaType === "video"),
        ).toHaveLength(2);
      }
    } finally {
      await application?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("导演台保存人物站位、机位画幅和关键帧", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-director-e2e-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.getByRole("textbox", { name: "新项目名称" }).fill("导演台验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 70, y: 100 } });
    await page
      .getByRole("region", { name: "添加节点菜单" })
      .getByRole("button", { name: "导演台", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "导演台" });
    await editor.getByRole("button", { name: "添加人物" }).click();
    await editor.getByLabel("人物或道具").selectOption({ label: "人物 1" });
    await editor.getByLabel("人物模型").selectOption("female");
    await editor.getByLabel("人物姿势").selectOption("wave");
    await expect(editor.getByRole("img", { name: "场景预览" })).toHaveAttribute(
      "data-figure-status",
      "ready",
    );
    await editor.getByLabel("横向站位").fill("2");
    await editor.getByRole("button", { name: "记录人物关键帧" }).click();
    await editor.getByRole("slider", { name: "时间" }).fill("1.5");
    await editor.getByLabel("横向站位").fill("3");
    await editor.getByRole("button", { name: "记录人物关键帧" }).click();
    await editor.getByRole("slider", { name: "时间" }).fill("0");
    await editor.getByRole("button", { name: "添加道具" }).click();
    await editor.getByLabel("人物或道具").selectOption({ label: "道具 1" });
    await editor.getByRole("combobox", { name: "道具形状" }).selectOption("table");
    await expect(editor.getByLabel("高度（米）")).toHaveValue("0.75");
    await editor.getByLabel("宽度（米）").fill("1.8");
    await editor.getByRole("button", { name: "添加机位" }).click();
    await editor.getByLabel("画幅").selectOption("9:16");
    await editor.getByLabel("机位看向").selectOption({ label: "人物 1" });
    const target = await editor.getByLabel("机位看向").inputValue();
    await editor.getByRole("button", { name: "记录机位关键帧" }).click();
    const scenePreview = editor.getByRole("img", { name: "场景预览" });
    await scenePreview.press("ArrowLeft");
    await scenePreview.press("Shift+ArrowUp");
    await editor.getByRole("button", { name: "放大视角" }).click();
    await editor.getByRole("button", { name: "机位", exact: true }).click();
    await expect(editor.getByRole("img", { name: "机位预览" })).toBeVisible();
    await expect(editor.getByRole("button", { name: "放大视角" })).toHaveCount(0);
    await editor.getByRole("button", { name: "保存场景" }).click();
    await expect
      .poll(async () => (await latestSnapshot(root)).canvas.nodes)
      .toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            director: expect.objectContaining({
              characters: [
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
                expect.objectContaining({
                  aspect: "9:16",
                  lookAt: target,
                  x: 0,
                  z: 5,
                  yaw: 0,
                  keys: [expect.objectContaining({ t: 0 })],
                }),
              ],
              props: [expect.objectContaining({ shape: "table", w: 1.8, h: 0.75, d: 0.8 })],
            }),
          }),
        }),
      ]);
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^导演台验收/ }).click();
    await reopened.getByText("新的导演台", { exact: true }).click();
    await reopened.getByRole("button", { name: "编辑导演台" }).click();
    const restored = reopened.getByRole("dialog", { name: "导演台" });
    await expect(restored.getByLabel("画幅")).toHaveValue("9:16");
    await expect(restored.getByLabel("机位看向")).toHaveValue(target);
    await expect(restored.getByRole("button", { name: "删除 0 秒关键帧" })).toBeVisible();
    await restored.getByLabel("人物或道具").selectOption(target);
    await expect(restored.getByLabel("人物模型")).toHaveValue("female");
    await expect(restored.getByLabel("人物姿势")).toHaveValue("wave");
    await expect(restored.getByRole("button", { name: "跳到 1.5 秒人物关键帧" })).toBeVisible();
    await restored.getByLabel("人物或道具").selectOption({ label: "道具 1" });
    await expect(restored.getByRole("combobox", { name: "道具形状" })).toHaveValue("table");
    await expect(restored.getByLabel("宽度（米）")).toHaveValue("1.8");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("导演台取消预演导出后可重试，并输出竖版 H.264 MP4", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-director-export-e2e-"));
  const output = join(root, "preview.mp4");
  const application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.getByRole("textbox", { name: "新项目名称" }).fill("导演台导出验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 70, y: 100 } });
    await page
      .getByRole("region", { name: "添加节点菜单" })
      .getByRole("button", { name: "导演台", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "导演台" });
    const exportButton = editor.getByRole("button", { name: "导出预演 MP4" });
    await editor.getByRole("button", { name: "添加人物" }).click();
    await editor.getByRole("button", { name: "添加机位" }).click();
    await editor.getByLabel("画幅").selectOption("9:16");
    await editor.getByLabel("场景时长（秒）").fill("15");
    await exportButton.click();
    await expect(editor.getByRole("progressbar")).toBeVisible();
    await editor.getByRole("button", { name: "取消导出" }).click();
    await expect(exportButton).toBeEnabled();
    await expect(editor.getByRole("alert")).toHaveCount(0);
    expect((await readdir(root)).filter((file) => file.startsWith("preview.mp4"))).toEqual([]);

    await editor.getByLabel("场景时长（秒）").fill("1.2");
    await application.evaluate(
      ({ dialog }, { failure, path }) => {
        const results = [
          { canceled: true, filePath: "" },
          { canceled: false, filePath: failure },
          { canceled: false, filePath: path },
        ];
        dialog.showSaveDialog = (async () => {
          const result = results.shift();
          if (!result) throw new Error("意外的保存对话框");
          return result;
        }) as typeof dialog.showSaveDialog;
      },
      { failure: root, path: output },
    );
    await exportButton.click();
    await expect(exportButton).toBeEnabled({ timeout: 20_000 });
    await expect(editor.getByRole("alert")).toHaveCount(0);
    expect(await readdir(root)).not.toContain("preview.mp4");

    await exportButton.click();
    await expect(editor.getByRole("alert")).toContainText("无法写入预演视频");
    expect(await readdir(root)).not.toContain("preview.mp4");

    await exportButton.click();
    await expect(editor.getByText("预演视频已保存。", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(editor.getByRole("alert")).toHaveCount(0);
    await expect.poll(async () => await readdir(root)).toContain("preview.mp4");
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
          "stream=codec_name,codec_type,width,height:format=duration,format_name",
          "-of",
          "json",
          output,
        ])
      ).toString(),
    );
    expect(probe.streams).toEqual([
      { codec_name: "h264", codec_type: "video", width: 720, height: 1280 },
    ]);
    expect(probe.format.format_name.split(",")).toContain("mp4");
    expect(Number(probe.format.duration)).toBeCloseTo(1.2, 1);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("画布视频可排序、混音并导出成片，结果回写项目素材库", async () => {
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
    await page.getByRole("textbox", { name: "新项目名称" }).fill("成片导出验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByRole("button", { name: "导入素材" }).click();
    await expect(page.getByText("red.mp4", { exact: true })).toBeVisible();
    await expect(page.getByText("blue.mp4", { exact: true })).toBeVisible();
    await expect(page.getByText("bgm.wav", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "将red.mp4加入画布" }).click();
    await page.getByRole("button", { name: "将blue.mp4加入画布" }).click();
    await page.getByRole("button", { name: "关闭素材库" }).click();

    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path,
      })) as typeof dialog.showSaveDialog;
    }, output);
    await page.getByRole("button", { name: "导出成片" }).click();
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
    await expect(page.getByRole("button", { name: "新建项目" })).toBeVisible();
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

async function createVideoFixture(root: string) {
  const clip = join(root, "source.mp4");
  const ffmpeg = join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg");
  await runMediaProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=24:d=1.2",
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
  let application = await launchCanvas(root, await createVideoFixture(root));
  try {
    const page = await application.firstWindow();
    await page.getByRole("textbox", { name: "新项目名称" }).fill("裁切验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将source.mp4加入画布" }).click();
    await page.getByRole("button", { name: "关闭素材库" }).click();
    await page.getByRole("button", { name: "裁切视频", exact: true }).click();
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
      reopened.locator(".react-flow__node").filter({ hasText: "source.mp4" }),
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

test("视频节点提帧并保留派生图片和来源连线", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-frame-e2e-"));
  let application = await launchCanvas(root, await createVideoFixture(root));
  try {
    const page = await application.firstWindow();
    await page.getByRole("textbox", { name: "新项目名称" }).fill("提帧验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("button", { name: "素材库", exact: true }).click();
    await page.getByRole("button", { name: "导入素材" }).click();
    await page.getByRole("button", { name: "将source.mp4加入画布" }).click();
    await page.getByRole("button", { name: "关闭素材库" }).click();
    await page.getByRole("button", { name: "提取帧", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "提取视频帧" });
    const time = dialog.getByRole("spinbutton", { name: "时间（秒）" });
    await time.fill("9");
    const extract = dialog.getByRole("button", { name: "提取并加入画布" });
    await expect(extract).toBeDisabled();
    await time.fill("0.25");
    await extract.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".react-flow__node img")).toHaveCount(1);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(1);
    expect(Object.values((await latestSnapshot(root)).assets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "derived",
          mediaType: "image",
          metadata: expect.objectContaining({ timeMs: 250, sourceAssetId: expect.any(String) }),
        }),
      ]),
    );
    await application.close();
    application = await launchCanvas(root);
    const reopened = await application.firstWindow();
    await reopened.getByRole("button", { name: /^提帧验收/ }).click();
    await expect(reopened.locator(".react-flow__node img")).toHaveCount(1);
    await expect(reopened.locator(".react-flow__edge")).toHaveCount(1);
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

test("S2 核心画布编辑、分组、历史和关闭恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-canvas-e2e-"));
  let application = await launchCanvas(root);
  try {
    const page = await application.firstWindow();
    await page.getByRole("textbox", { name: "新项目名称" }).fill("核心画布验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "项目素材" })).toBeHidden();
    await expect(page.getByRole("region", { name: "画布小灵" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "从一个想法开始" })).toBeVisible();
    await page.screenshot({ path: "test-results/canvas-empty.png" });
    await page.getByRole("button", { name: /^文本 记录灵感/ }).click();
    const script = page.getByRole("textbox", { name: "新的文本节点内容" });
    const sourceNode = page.locator(".react-flow__node").filter({ has: script });
    const scriptId = await sourceNode.getAttribute("data-id");
    await expect(page.getByRole("heading", { name: "从一个想法开始" })).toBeHidden();
    await script.fill("第一版");
    await script.fill("第二版");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(script).toHaveValue("");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(script).toHaveValue("第二版");
    const pane = page.locator(".react-flow__pane");
    const paneBounds = await pane.boundingBox();
    if (!paneBounds) throw new Error("画布不可见");
    const clickPoint = {
      x: Math.round(paneBounds.x + paneBounds.width * 0.69),
      y: Math.round(paneBounds.y + 140),
    };
    const addMenu = page.getByRole("region", { name: "添加节点菜单" });
    await page.getByRole("button", { name: "抓手" }).click();
    await page.mouse.move(clickPoint.x, clickPoint.y);
    await page.mouse.down();
    await page.mouse.move(clickPoint.x + 45, clickPoint.y + 12, { steps: 6 });
    await page.mouse.up();
    await expect(addMenu).toBeHidden();
    await page.getByRole("button", { name: "选择", exact: true }).click();
    await page.mouse.click(clickPoint.x, clickPoint.y);
    await expect(addMenu).toBeHidden();
    await page.mouse.click(clickPoint.x, clickPoint.y);
    await expect(addMenu).toBeHidden();
    await page.mouse.click(clickPoint.x, clickPoint.y, { button: "right" });
    await expect(addMenu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(addMenu).toBeHidden();
    await page.mouse.click(clickPoint.x, clickPoint.y, { button: "right" });
    await expect(addMenu).toBeVisible();
    await addMenu.getByRole("button", { name: "图片", exact: true }).click();
    const imageNode = page.locator(".react-flow__node").filter({ hasText: "新的图片节点" });
    await expect(imageNode).toBeVisible();
    const imageBounds = await imageNode.boundingBox();
    expect(imageBounds?.x).toBeCloseTo(clickPoint.x, 0);
    expect(imageBounds?.y).toBeCloseTo(clickPoint.y, 0);
    const sourceHandle = sourceNode.locator(".react-flow__handle-right");
    const targetHandle = imageNode.locator(".react-flow__handle-left");
    await expect(page.getByText("画布已同步到项目")).toBeVisible();
    await sourceHandle.dragTo(targetHandle);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await sourceNode.locator("header strong").click();
    await imageNode.locator("header strong").click({ modifiers: ["Shift"] });
    const selection = page.getByRole("toolbar", { name: "多选节点操作" });
    const beforeLayout = (await latestSnapshot(root)).canvas.nodes;
    await selection.getByRole("button", { name: "纵向排列" }).click();
    await expect
      .poll(async () => {
        const positions = (await latestSnapshot(root)).canvas.nodes.map(
          (node) => (node as { position: { x: number } }).position.x,
        );
        return new Set(positions).size;
      })
      .toBe(1);
    await selection.getByRole("button", { name: "复制所选节点" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(2);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.nodes).toEqual(beforeLayout);
    await sourceNode.locator("header strong").click();
    await imageNode.locator("header strong").click({ modifiers: ["Shift"] });
    await page.getByRole("button", { name: "分组", exact: true }).click();
    const group = page.locator(".canvas-group");
    await expect(group).toHaveText("新分组");
    await page.getByRole("button", { name: "节点属性" }).click();
    const properties = page.getByRole("region", { name: "节点属性" });
    await properties.getByRole("textbox", { name: "名称" }).fill("镜头一");
    await expect(group).toHaveText("镜头一");
    await page.getByRole("button", { name: "关闭侧栏" }).click();
    await group.locator("svg").click();
    await page.keyboard.press("ControlOrMeta+d");
    await expect(group).toHaveCount(2);
    await expect(page.getByText("镜头一 副本", { exact: true })).toBeVisible();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect.poll(async () => (await latestSnapshot(root)).canvas.nodes.length).toBe(6);
    const copied = (await latestSnapshot(root)).canvas;
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
    await page.getByRole("button", { name: "解除分组" }).click();
    await expect(group).toHaveCount(0);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(group).toHaveText("镜头一");
    await page.getByRole("button", { name: "缩小", exact: true }).click();
    await expect(page.getByText("画布已同步到项目")).toBeVisible();
    await expect.poll(async () => (await latestSnapshot(root)).canvas.edges).toHaveLength(1);
    const saved = (await latestSnapshot(root)).canvas;
    expect(saved.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: scriptId, parentId: expect.any(String) }),
        expect.objectContaining({
          type: "group",
          data: { label: "镜头一" },
          position: expect.objectContaining({ x: expect.any(Number) }),
        }),
      ]),
    );
    expect(saved.viewport.zoom).toBeLessThan(1);
    expect(JSON.stringify(saved)).not.toMatch(/selected|dragging|measured|uploadProgress/);
    await script.fill("关闭前最后一笔");
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
    await expect(restored.locator(".react-flow__edge")).toHaveCount(1);
    await expect(restored.getByRole("textbox", { name: "新的文本节点内容" })).toHaveValue(
      "关闭前最后一笔",
    );
    await expect(restored.getByText("画布已同步到项目")).toBeVisible();
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
      await page.getByRole("button", { name: "新建项目" }).click();
      await page.getByRole("button", { name: /^文本 记录灵感/ }).click();
      const script = page.getByRole("textbox", { name: "新的文本节点内容" });
      await expect(script).toBeVisible();
      const scriptId = await script.getAttribute("data-node-id");
      await page.getByRole("button", { name: "保存项目" }).click();
      await expect(page.getByText("画布已同步到项目")).toBeVisible();
      const originalRevision = (await latestSnapshot(root)).canvas.revision;
      const directory = await projectDirectory(root);
      const temporary = join(directory, "tmp");
      const detached = join(directory, "tmp-detached");
      await rename(temporary, detached);
      try {
        await script.fill("写入失败时的草稿");
        await expect(page.getByText("画布保存失败，本地更改已保留")).toBeVisible();
        expect((await latestSnapshot(root)).canvas.revision).toBe(originalRevision);
        await projectAction(page, "关闭项目");
        await expect(script).toHaveValue("写入失败时的草稿");
        await expect(page.getByRole("button", { name: "重试保存" })).toBeEnabled();
        await script.fill("故障期间继续改稿");
      } finally {
        await rename(detached, temporary);
      }
      await page.getByRole("button", { name: "重试保存" }).click();
      await expect(page.getByText("画布已同步到项目")).toBeVisible();
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
