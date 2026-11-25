import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, type Locator, test } from "@playwright/test";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { applyCanvas, projectCanvas } from "../../src/main/project/canvas";
import { addDramaSegment, createDrama } from "../../src/main/project/drama";
import { mergeDramaAssets } from "../../src/main/project/drama-assets";
import { ProjectStore } from "../../src/main/project/store";
import { requireTestValue } from "../require-test-value";
import { projectAction } from "./workspace-actions";

test("短剧：跨工序保留当前集，全集筛选、快捷键和编辑保存互不干扰", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-stage-route-"));
  const store = await ProjectStore.create(root, "两封信"),
    directory = store.directory;
  try {
    const doc = await createDrama(store, {
      title: "两封信",
      script: "第一集 送信\n门口响了三声。\n第二集 回信\n雨停了。",
    });
    let revision = doc.revision;
    for (const episode_no of [1, 2])
      revision = (
        await addDramaSegment(store, {
          episode_no,
          revision,
          prompt: `第${episode_no}个片段`,
          seconds: 5,
        })
      ).revision;
    await store.updateGeneration((state) => {
      mergeDramaAssets(
        state,
        [
          { name: "信使", episodes: [1] },
          { name: "收信人", episodes: [2] },
          { name: "讲述者", episodes: [] },
        ].map((fields) => ({
          ...fields,
          type: "character",
          look: "",
          description: "",
          aliases: [],
          voice_prompt: "",
        })),
      );
      state.canvas = applyCanvas(state, [
        {
          type: "putNode",
          node: {
            id: "manual-character",
            type: "creative",
            position: { x: 0, y: 300 },
            data: {
              kind: "image",
              label: "未分类角色",
              text: "",
              character: {
                name: "未分类角色",
                look: "基础形象",
                description: "",
                extraAssetIds: [],
              },
            },
          },
        },
      ]);
      return { changed: true, result: null };
    });
  } finally {
    await store.close();
  }
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: root };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath
      ? { executablePath, args: [] }
      : { args: [process.env.LINK_STUDIO_E2E_APP ?? "."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, directory);
    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    await projectAction(page, "短剧工作室");
    const tabs = page.getByRole("tablist", { name: "制作工序" }),
      tab = (name: string) => tabs.getByRole("tab", { name, exact: true });
    const rail = page.getByRole("navigation", { name: "分集" }),
      assetList = page.getByRole("region", { name: "资产列表" });
    const script = page.getByLabel("分集剧本", { exact: true }),
      input = page.getByLabel("片段提示词");
    const url = page.url();
    await expect(tab("总览")).toHaveAttribute("aria-selected", "true");
    await expect(rail).toHaveCount(0);
    await expect(page.getByRole("progressbar", { name: "整体完成度 20%" })).toBeVisible();
    await page.getByRole("button", { name: "继续制作第 1 集" }).click();
    await expect(script).toContainText("门口响了三声。");
    await tab("总览").click();
    await page.getByRole("button", { name: "第 2 集 剧本", exact: true }).click();
    await expect(script).toContainText("雨停了。");
    await script.fill("二集手写回信。");
    await tab("资产管理").click();
    await expect(assetList.getByRole("heading")).toHaveText("资产管理 · 第 2 集");
    await expect(assetList.locator(".drama-asset-caption")).toHaveText(["收信人", "讲述者"]);
    const view = assetList.getByRole("group", { name: "视图" }),
      canvasArea = assetList.getByRole("main", { name: "创作画布" });
    await assetList.getByRole("button", { name: "在画布中打开 收信人" }).click();
    await expect(view.getByRole("button", { name: "画布" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvasArea.locator(".react-flow__node.selected")).toContainText("收信人");
    const picker = assetList.getByRole("button", { name: "出现集数" });
    await picker.click();
    const popup = page.getByRole("dialog", { name: "编辑出现集数" });
    await expect(popup.getByRole("button", { name: "2", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await popup.getByRole("button", { name: "1", exact: true }).click();
    await popup.press("Escape");
    const search = assetList.getByLabel("搜索资产");
    await search.fill("信使");
    await assetList
      .getByRole("complementary", { name: "画布资产定位" })
      .getByRole("button", { name: "信使" })
      .click();
    await expect(canvasArea.locator(".react-flow__node.selected")).toContainText("信使");
    await view.getByRole("button", { name: "列表" }).click();
    await expect(
      assetList.getByRole("listitem", { name: "收信人" }).locator(".drama-asset-badges i"),
    ).toHaveText(["1", "2"]);
    const editPrompt = assetList.getByRole("button", { name: "编辑 收信人 的提示词" }),
      promptDialog = page.getByRole("dialog", { name: /收信人/ });
    await editPrompt.click();
    await expect(promptDialog.getByText("提示词与生成设置")).toBeVisible();
    const enlarge = promptDialog.getByRole("button", { name: "放大编辑提示词" });
    await enlarge.click();
    const enlarged = page.getByRole("dialog", { name: "编辑提示词" });
    await enlarged.getByRole("textbox", { name: "生成提示词" }).fill("收信人穿着蓝色雨衣。");
    await enlarged.press("Escape");
    await expect(enlarge).toBeFocused();
    await expect(promptDialog.getByRole("textbox", { name: "生成提示词" })).toContainText(
      "收信人穿着蓝色雨衣。",
    );
    await promptDialog.getByRole("button", { name: "角色详情与音色" }).click();
    await expect(promptDialog).toHaveCount(0);
    await page
      .getByRole("dialog", { name: "角色卡" })
      .getByRole("button", { name: "关闭角色卡" })
      .click();
    await editPrompt.click();
    await promptDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(view.getByRole("button", { name: "列表" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const narrator = assetList.getByRole("listitem", { name: "讲述者" }),
      pill = narrator.locator(".drama-asset-fill");
    await page.mouse.move(0, 0);
    await assetList.getByRole("listitem", { name: "收信人" }).getByRole("button").last().focus();
    await page.keyboard.press("Tab");
    await expect(narrator.getByRole("button", { name: "上传" })).toBeFocused();
    await expect(pill).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(narrator.getByRole("button", { name: "资产库" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(narrator.getByRole("button", { name: /在画布中打开/ })).toBeFocused();
    await expect(pill).toHaveCSS("opacity", "0");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    const library = page.getByRole("dialog", { name: "选择形象主图" });
    await expect(library).toBeVisible();
    await library.press("Escape");
    await app.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      },
      join(process.cwd(), "resources/icons/icon-32.png"),
    );
    await narrator.getByRole("button", { name: "上传" }).click();
    await expect(narrator.getByRole("img", { name: "讲述者" })).toBeVisible();
    await expect(narrator.getByRole("button", { name: "编辑 讲述者 的提示词" })).toHaveCount(0);
    await narrator.getByRole("button", { name: "编辑 讲述者 的角色详情与音色" }).click();
    const character = page.getByRole("dialog", { name: "角色卡" });
    await expect(character.getByLabel("主图", { exact: true })).toHaveText("icon-32.png");
    await character.getByRole("button", { name: "关闭角色卡" }).click();
    const props = assetList.getByRole("tab", { name: /^道具/ });
    await props.click();
    await assetList.getByRole("button", { name: "新建道具 出现在第 2 集" }).click();
    const newProp = assetList.locator("[data-asset-id]");
    await expect(newProp).toHaveCount(1);
    const propId = await newProp.getAttribute("data-asset-id");
    expect(propId).toBeTruthy();
    await expect(newProp.locator(".drama-asset-badges i")).toHaveText("2");
    await newProp.getByRole("button", { name: /在画布中打开/ }).click();
    await expect(canvasArea.locator(".react-flow__node.selected")).toHaveAttribute(
      "data-id",
      requireTestValue(propId),
    );
    await tab("片场").click();
    await expect(page.getByText("第2个片段 · 5 秒")).toBeVisible();
    await expect(page.getByText("第1个片段 · 5 秒")).toHaveCount(0);
    await input.pressSequentially("3]");
    await expect(input).toHaveValue("3]");
    await expect(tab("片场")).toHaveAttribute("aria-selected", "true");
    await rail.getByRole("button", { name: "人物传记" }).click();
    await expect(tab("剧本")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "人物传记", exact: true })).toBeVisible();
    await tab("总览").click();
    await page.keyboard.press("5");
    await expect(page.getByRole("heading", { name: "第 2 集还没有成片" })).toBeVisible();
    await page.getByRole("button", { name: "去片场" }).click();
    await expect(page.getByText("第2个片段 · 5 秒")).toBeVisible();
    await page.keyboard.press("[");
    await expect(page.getByText("第1个片段 · 5 秒")).toBeVisible();
    await page.keyboard.press("]");
    await expect(page.getByText("第2个片段 · 5 秒")).toBeVisible();
    await tab("资产管理").click();
    await rail.getByRole("button", { name: "全集" }).click();
    await expect(assetList.locator(".drama-asset-caption")).toHaveText([
      "信使",
      "收信人",
      "讲述者",
      "未分类角色",
    ]);
    await page.keyboard.press("2");
    await expect(script).toContainText("门口响了三声。");
    expect(page.url()).toBe(url);
    await page.getByRole("button", { name: "返回画布" }).click();
    await projectAction(page, "关闭项目");
    await page.getByRole("button", { name: /^两封信/ }).click();
    await projectAction(page, "短剧工作室");
    await page.getByRole("button", { name: "第 2 集 剧本", exact: true }).click();
    await expect(script).toHaveText("二集手写回信。");
    await tab("资产管理").click();
    await rail.getByRole("button", { name: /^第 1 集 ·/ }).click();
    await expect(
      assetList.getByRole("listitem", { name: "收信人" }).locator(".drama-asset-badges i"),
    ).toHaveText(["1", "2"]);
    await editPrompt.click();
    await expect(promptDialog.getByRole("textbox", { name: "生成提示词" })).toContainText(
      "收信人穿着蓝色雨衣。",
    );
    await promptDialog.press("Escape");
    await expect(narrator.getByRole("img", { name: "讲述者" })).toBeVisible();
    await props.click();
    await expect(assetList.locator("[data-asset-id]")).toHaveCount(0);
    await rail.getByRole("button", { name: /^第 2 集 ·/ }).click();
    await expect(newProp).toHaveAttribute("data-asset-id", requireTestValue(propId));
    await rail.getByRole("button", { name: "全集" }).click();
    await assetList.getByRole("tab", { name: /^文本/ }).click();
    await assetList.getByRole("button", { name: "新建文本 全集出现" }).click();
    await expect(newProp.locator(".drama-asset-badges")).toHaveText("全集");
    await rail.getByRole("button", { name: /^第 1 集 ·/ }).click();
    await expect(newProp.locator(".drama-asset-badges")).toHaveText("全集");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("资产列表：原生文件拖入空卡、已占卡、空白和文本，分集重开后不变", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "link-drama-file-drop-"));
  const store = await ProjectStore.create(root, "拖入资产"),
    directory = store.directory;
  try {
    await createDrama(store, {
      title: "拖入资产",
      script: "第一集 来信\n收到一封信。\n第二集 回信\n回信已寄出。",
    });
  } finally {
    await store.close();
  }
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: root };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath
      ? { executablePath, args: [] }
      : { args: [process.env.LINK_STUDIO_E2E_APP ?? "."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, directory);
    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    await projectAction(page, "短剧工作室");
    const list = page.getByRole("region", { name: "资产列表" }),
      cards = list.locator("[data-asset-id]"),
      overlay = list.getByText("松手上传");
    const assets = page.getByRole("tab", { name: "资产管理", exact: true }),
      rail = page.getByRole("navigation", { name: "分集" });
    const episode = (no: number) =>
      rail.getByRole("button", { name: new RegExp(`^第 ${no} 集 ·`) });
    const selectAssetType = async (name: string) => {
      const tab = list.getByRole("tab", { name: new RegExp(`^${name}`) });
      await tab.press("Enter");
      await expect(tab).toHaveAttribute("aria-selected", "true");
    };
    await assets.press("Enter");
    await episode(2).click();
    const session = await page.context().newCDPSession(page);
    const drag = async (
      target: Locator,
      files: string[],
      accept = true,
      cancel = false,
      blank = false,
    ) => {
      await target.scrollIntoViewIfNeeded();
      const rect = await target.boundingBox();
      if (!rect) throw Error("拖入目标不可见");
      const params = {
        x: rect.x + (blank ? 4 : rect.width / 2),
        y: rect.y + (blank ? 4 : rect.height / 2),
        data: { items: [], files, dragOperationsMask: 1 },
      };
      if (blank)
        expect(
          await page.evaluate(
            ({ x, y }) =>
              !!document.elementFromPoint(x, y)?.closest(".drama-asset-drop-zone") &&
              !document.elementFromPoint(x, y)?.closest("li"),
            { x: params.x, y: params.y },
          ),
        ).toBe(true);
      for (const type of ["dragEnter", "dragOver"] as const)
        await session.send("Input.dispatchDragEvent", { type, ...params });
      if (accept) await expect(overlay).toBeVisible();
      else await expect(overlay).toHaveCount(0);
      if (cancel)
        await session.send("Input.dispatchDragEvent", { type: "dragOver", ...params, x: 5, y: 5 });
      await session.send("Input.dispatchDragEvent", {
        type: cancel ? "dragCancel" : "drop",
        ...params,
      });
      await expect(overlay).toHaveCount(0);
    };
    const icon = (size: number) => join(process.cwd(), `resources/icons/icon-${size}.png`),
      wrong = join(process.cwd(), "package.json");
    const add = list.getByRole("button", { name: "引入角色卡 出现在第 2 集" });
    await add.click();
    const originalId = await cards.getAttribute("data-asset-id"),
      original = list.locator(`[data-asset-id="${originalId}"]`);
    await drag(original, [icon(16)], true, true);
    await expect(original).toHaveAttribute("data-status", "idle");
    await drag(original, [wrong]);
    await expect(page.getByText("这个节点只收图片", { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(1);
    const broken = join(root, "损坏.png");
    await writeFile(broken, "not an image");
    await drag(original, [broken]);
    await expect(page.getByText("上传失败，请重新拖入文件", { exact: true })).toBeVisible();
    await expect(original).toHaveAttribute("data-status", "idle");
    await drag(original, [icon(16)]);
    await expect(original.locator("img")).toBeVisible();
    await expect(cards).toHaveCount(1);
    await drag(original, [icon(32)]);
    await expect(cards.locator("img")).toHaveCount(2);
    await original.getByRole("button", { name: /角色详情与音色/ }).click();
    const detail = page.getByRole("dialog", { name: "角色卡" });
    await expect(detail.getByLabel("主图", { exact: true })).toHaveText("icon-16.png");
    await detail.getByRole("button", { name: "关闭角色卡" }).click();
    await selectAssetType("道具");
    await list.getByRole("button", { name: "新建道具 出现在第 2 集" }).click();
    const emptyId = await cards.getAttribute("data-asset-id"),
      empty = list.locator(`[data-asset-id="${emptyId}"]`);
    await drag(empty, [icon(48), wrong, icon(64)]);
    await expect(cards).toHaveCount(3);
    await expect(empty).toHaveAttribute("data-status", "idle");
    await expect(cards.locator("img")).toHaveCount(2);
    await drag(empty, [icon(128)]);
    await expect(empty.locator("img")).toBeVisible();
    await expect(cards).toHaveCount(3);
    await expect(cards.locator(".drama-asset-badges i")).toHaveText(["2", "2", "2"]);
    await selectAssetType("文本");
    await drag(list.getByRole("button", { name: /新建文本/ }), [icon(16)], false);
    await expect(cards).toHaveCount(0);
    const ffmpeg = join(
      process.cwd(),
      "out/media",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    for (const [tab, file, input, encoding] of [
      ["音频", "环境.wav", "sine=frequency=660:sample_rate=8000", ["-t", "0.1"]],
      [
        "视频",
        "外景.mp4",
        "color=c=blue:s=64x48",
        [
          "-frames:v",
          "3",
          ...(process.platform === "darwin"
            ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
            : ["-c:v", "libx264"]),
        ],
      ],
    ] as const) {
      const source = join(root, file);
      await runMediaProcess(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        input,
        ...encoding,
        source,
      ]);
      await selectAssetType(tab);
      await drag(list.locator(".drama-asset-drop-zone"), [source], true, false, true);
      await expect(cards).toHaveAttribute("data-status", "done");
      await expect(cards.locator(".drama-asset-badges i")).toHaveText("2");
    }
    await rail.getByRole("button", { name: "全集" }).click();
    await selectAssetType("场景");
    await drag(list.locator(".drama-asset-drop-zone"), [icon(256)], true, false, true);
    await expect(cards.locator("img")).toBeVisible();
    await expect(cards.locator(".drama-asset-badges")).toHaveText("全集");
    await session.detach();
    await page.getByRole("button", { name: "返回画布" }).click();
    await projectAction(page, "关闭项目");
    await page.getByRole("button", { name: /^拖入资产/ }).click();
    await projectAction(page, "短剧工作室");
    await assets.press("Enter");
    await episode(1).click();
    await selectAssetType("道具");
    await expect(cards).toHaveCount(0);
    await selectAssetType("场景");
    await expect(cards.locator("img")).toBeVisible();
    await episode(2).click();
    await selectAssetType("道具");
    await expect(cards.locator("img")).toHaveCount(3);
    await expect(empty.locator("img")).toBeVisible();
    await page.getByRole("button", { name: "返回画布" }).click();
    await projectAction(page, "关闭项目");
    await expect(page.getByRole("button", { name: "打开项目", exact: true })).toBeVisible();
    const reopened = await ProjectStore.open(directory);
    try {
      const snapshot = reopened.snapshot,
        graph = projectCanvas(snapshot.canvas).nodes.filter((node) => node.type === "creative");
      expect(graph).toHaveLength(8);
      for (const node of graph) {
        const data = node.data;
        expect(data.assetId).toBeTruthy();
        expect(data).not.toHaveProperty("uploadPending");
        if (data.character) {
          expect(data.uploaded).toBeUndefined();
          expect(data.activeOutputId).toBe(data.assetId);
          expect(data.outputs?.map((output) => output.id)).toEqual([data.assetId]);
        } else expect(data.uploaded).toBe(true);
      }
      const added = graph.filter(
        (node) =>
          node.data.drama &&
          "type" in node.data.drama &&
          node.data.drama.type === "prop" &&
          node.id !== emptyId,
      );
      expect(
        added.map(
          (node) =>
            requireTestValue(snapshot.assets[requireTestValue(node.data.assetId)]).displayName,
        ),
      ).toEqual(["icon-48.png", "icon-64.png"]);
      expect(requireTestValue(added[1]).position).toEqual({
        x: requireTestValue(added[0]).position.x + 440,
        y: requireTestValue(added[0]).position.y,
      });
      for (const [kind, file] of [
        ["audio", "环境.wav"],
        ["video", "外景.mp4"],
      ]) {
        const node = graph.find((item) => item.data.kind === kind);
        expect(
          requireTestValue(snapshot.assets[requireTestValue(requireTestValue(node).data.assetId)])
            .displayName,
        ).toBe(file);
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
