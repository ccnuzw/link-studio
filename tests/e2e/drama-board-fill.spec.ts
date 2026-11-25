import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { projectCanvas } from "../../src/main/project/canvas";
import { addDramaSegment, createDrama, dramaDocument } from "../../src/main/project/drama";
import { mergeDramaAssets } from "../../src/main/project/drama-assets";
import { syncDramaBoards } from "../../src/main/project/drama-boards";
import { ProjectStore } from "../../src/main/project/store";
import { requireTestValue } from "../require-test-value";
import { projectAction } from "./workspace-actions";

test("批量故事板允许部分失败，再次补图只请求失败片段", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-board-fill-"));
  const store = await ProjectStore.create(root, "双片段");
  const directory = store.directory;
  try {
    let { revision } = await createDrama(store, { title: "双片段", script: "灯亮了。门开了。" });
    for (const [prompt, seconds] of [
      ["灯亮了。", 5],
      ["门开了。", 20],
    ] as const) {
      const updated = await addDramaSegment(store, { episode_no: 1, revision, prompt, seconds });
      revision = updated.revision;
    }
    await store.updateGeneration((state) => {
      const doc = requireTestValue(dramaDocument(state));
      requireTestValue(doc.episodes[0]).locked = true;
      requireTestValue(doc.episodes[0]).storyboard_status = "ready";
      syncDramaBoards(state, 1, requireTestValue(doc.segments));
      mergeDramaAssets(
        state,
        (["character", "scene", "prop"] as const).map((type) => ({
          type,
          name: type,
          look: "",
          description: "",
          aliases: [],
          episodes: type === "prop" ? [2] : [1],
          voice_prompt: "",
        })),
      );
      return { changed: true, result: null };
    });
  } finally {
    await store.close();
  }
  const requests: string[] = [];
  const payloads: { prompt: string; model: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const { prompt, model } = JSON.parse(Buffer.concat(chunks).toString());
    payloads.push({ prompt, model });
    const label = prompt.includes("灯亮了。") ? "灯" : "门";
    requests.push(label);
    if (label === "灯" && requests.filter((item) => item === label).length === 1) {
      response.writeHead(400).end(JSON.stringify({ error: { message: "第一版失败" } }));
    } else {
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
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("缺少测试端口");
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
    const models = await page.evaluate(async (endpoint) => {
      const list = await window.desktop.settings.list({});
      const image = list.ok && list.value.plugins.find((plugin) => plugin.key === "openai-image");
      if (!image) throw Error("缺少图片适配器");
      const saved = await window.desktop.settings.save({
        expectedRevision: 0,
        pluginHash: image.hash,
        approve: true,
        secret: "fixture",
        fields: {
          label: "测试出图",
          model: "gpt-image-1",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!saved.ok) throw Error(saved.code);
      const scene = await window.desktop.settings.save({
        expectedRevision: 0,
        pluginHash: image.hash,
        approve: true,
        secret: "fixture",
        fields: {
          label: "场景出图",
          model: "scene-image",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!scene.ok) throw Error(scene.code);
      return { board: saved.value.id, scene: scene.value.id };
    }, `http://127.0.0.1:${address.port}`);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, directory);
    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    await projectAction(page, "短剧工作室");
    const openSettings = page.getByRole("button", { name: "项目设置", exact: true });
    const settings = page.getByRole("dialog", { name: "项目设置" });
    const done = settings.getByRole("button", { name: "完成" });
    const body = "水彩{{格数}}格 {{比例}}\n{{画面}}";
    await openSettings.click();
    await settings.getByRole("button", { name: "人物图片模型", exact: true }).click();
    await settings.getByRole("button", { name: "场景出图", exact: true }).click();
    await settings.getByRole("button", { name: "场景图片模型", exact: true }).click();
    await settings.getByRole("button", { name: "场景出图", exact: true }).click();
    await settings.getByRole("button", { name: "物品图片模型", exact: true }).click();
    await settings.getByRole("button", { name: "测试出图", exact: true }).click();
    const boardChoice = settings.getByRole("button", { name: "故事板提示词", exact: true });
    await boardChoice.click();
    await settings.getByRole("button", { name: "新建", exact: true }).click();
    await settings.getByLabel("名称", { exact: true }).fill("双片段水彩");
    const editor = settings.getByRole("textbox", { name: "提示词正文" });
    await editor.fill("水彩");
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await expect(settings.getByRole("alert")).toContainText("{{画面}}");
    await editor.fill(body);
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await expect(boardChoice).toHaveText("我的 · 双片段水彩");
    await done.click();
    await page.getByRole("tab", { name: "片场", exact: true }).click();
    const seconds = page.getByTitle("片段时长 · 模型上限 15s");
    await expect(seconds).toHaveText("5s");
    await page.getByRole("button", { name: "片段 2，20 秒" }).click();
    await expect(seconds).toHaveText("20s");
    await seconds.click();
    const durations = page.getByRole("dialog", { name: "片段时长" });
    await expect(durations.getByRole("button")).toHaveText([
      "3s",
      "4s",
      "5s",
      "6s",
      "8s",
      "10s",
      "12s",
      "15s",
      "20s超出模型上限",
    ]);
    await durations.getByRole("button", { name: "12s", exact: true }).click();
    await expect(page.getByRole("button", { name: "片段 2，12 秒" })).toBeVisible();
    await page.getByRole("button", { name: "片段 1，5 秒" }).click();
    const stage = page.getByRole("region", { name: "故事板预览" });
    const toggle = page.getByRole("group", { name: "视图" }),
      canvasFace = page.getByRole("region", { name: "片场画布" });
    await stage.getByRole("button", { name: "进入画布查看" }).click();
    await expect(toggle.getByRole("button", { name: "画布" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvasFace.locator(".react-flow__node.selected")).toContainText(
      "故事板 · 第 1 集 · 01",
    );
    await expect(page.getByRole("button", { name: "批量生成脚本", exact: true })).toHaveCount(0);
    await expect(seconds).toHaveCount(0);
    const selectedBoard = canvasFace.locator(".react-flow__node.selected");
    const boardId = await selectedBoard.getAttribute("data-id");
    const flow = await canvasFace.locator(".react-flow").elementHandle();
    await toggle.getByRole("button", { name: "片场", exact: true }).click();
    await expect(stage).toBeVisible();
    await expect(page.getByRole("button", { name: "片段 1，5 秒" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await toggle.getByRole("button", { name: "画布" }).click();
    expect(
      await flow.evaluate(
        (node) => node === document.querySelector('[aria-label="片场画布"] .react-flow'),
      ),
    ).toBe(true);
    await selectedBoard
      .getByRole("button", { name: "重命名节点：故事板 · 第 1 集 · 01", exact: true })
      .press("Enter");
    const title = selectedBoard.getByRole("textbox", { name: "节点名称" });
    await title.fill("片场灯光草图");
    await title.press("Enter");
    await expect(selectedBoard.getByText("片场灯光草图", { exact: true })).toBeVisible();
    await toggle.getByRole("button", { name: "片场", exact: true }).click();
    const fill = page.getByRole("button", { name: /^批量生成故事板/ });
    await expect(fill).toHaveText("批量生成故事板 · 2");
    await fill.click();
    const dialog = page.getByRole("dialog", { name: /张故事板/ });
    await expect(dialog).toContainText("片段 01、02");
    await dialog.getByRole("button", { name: "开始生成" }).click();
    await expect.poll(() => requests.slice().sort()).toEqual(["灯", "门"]);
    await expect(stage.getByRole("button", { name: "重新生成" })).toBeVisible();
    await expect(fill).toHaveText("批量生成故事板 · 1");
    await fill.click();
    await expect(dialog.getByText("片段 01", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "开始生成" }).click();
    await expect(stage.getByRole("img", { name: "片段 1 的故事板" })).toBeVisible();
    await expect(fill).toBeDisabled();
    expect(requests.filter((label) => label === "灯")).toHaveLength(2);
    expect(requests.filter((label) => label === "门")).toHaveLength(1);
    for (const payload of payloads) {
      expect(payload.model).toBe("scene-image");
      expect(payload.prompt).toContain("水彩4格 16:9");
    }
    await openSettings.click();
    await boardChoice.click();
    await settings.getByRole("button", { name: "删除 双片段水彩" }).click();
    await expect(settings.getByRole("button", { name: "删除 双片段水彩" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await settings.getByRole("button", { name: "取消" }).click();
    await openSettings.click();
    await expect(boardChoice).toHaveAttribute("title", /使用快照/);
    await settings.getByRole("button", { name: "故事板图片模型", exact: true }).click();
    await settings.getByRole("button", { name: "测试出图", exact: true }).click();
    await done.click();
    await stage.getByRole("button", { name: "重新生成" }).click();
    await expect.poll(() => payloads[3]?.model).toBe("gpt-image-1");
    expect(payloads[3]?.prompt).toContain("水彩4格 16:9");
    await expect(stage.getByRole("img", { name: "片段 1 的故事板" })).toBeVisible();
    await openSettings.click();
    await boardChoice.click();
    await settings.getByRole("button", { name: "内置 推荐" }).click();
    await settings.getByRole("button", { name: "取消" }).click();
    const sourcePrompt = page.getByRole("textbox", { name: "片段原稿" });
    await sourcePrompt.fill("灯亮了。镜头转向窗沿。");
    await page.setViewportSize({ width: 1279, height: 900 });
    const library = page.getByRole("complementary", { name: "资产库" });
    await expect(library).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(library.getByRole("button", { name: "本集" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(library.getByText("scene", { exact: true })).toBeVisible();
    await expect(library.getByText("prop", { exact: true })).toHaveCount(0);
    await library.getByRole("button", { name: "全集" }).click();
    const prop = library.getByTitle("拖到提示词里").filter({ hasText: "prop" });
    await prop.dragTo(sourcePrompt, { targetPosition: { x: 2, y: 5 } });
    const chip = sourcePrompt.locator("[data-ref]");
    await expect(chip).toHaveText("prop");
    await expect(chip).toHaveAttribute("data-gone", "false");
    const refId = await chip.getAttribute("data-ref");
    await page.getByRole("button", { name: "返回画布" }).click();
    await projectAction(page, "关闭项目");
    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    await projectAction(page, "短剧工作室");
    await openSettings.click();
    await expect(settings.getByRole("button", { name: "场景图片模型", exact: true })).toContainText(
      "场景出图",
    );
    await expect(
      settings.getByRole("button", { name: "故事板图片模型", exact: true }),
    ).toContainText("测试出图");
    await expect(boardChoice).toHaveText("我的 · 双片段水彩");
    await expect(boardChoice).toHaveAttribute("title", /使用快照/);
    await expect(settings.getByRole("button", { name: "人物图片模型", exact: true })).toContainText(
      "场景出图",
    );
    await expect(settings.getByRole("button", { name: "物品图片模型", exact: true })).toContainText(
      "测试出图",
    );
    await settings.getByRole("button", { name: "取消" }).click();
    await page.getByRole("tab", { name: "片场", exact: true }).click();
    await page.getByRole("button", { name: "片段 1，5 秒" }).click();
    await expect(chip).toHaveAttribute("data-ref", requireTestValue(refId));
    await expect(sourcePrompt).toHaveText("prop 灯亮了。镜头转向窗沿。");
    await page.getByRole("button", { name: "返回画布" }).click();
    await projectAction(page, "关闭项目");
    await expect(page.getByRole("button", { name: "打开项目", exact: true })).toBeVisible();
    const reopened = await ProjectStore.open(directory);
    try {
      expect(
        dramaDocument(reopened.snapshot)?.segments?.map(({ prompt, seconds }) => [prompt, seconds]),
      ).toEqual([
        [`@[prop](${refId}) 灯亮了。镜头转向窗沿。`, 5],
        ["门开了。", 12],
      ]);
      const nodes = projectCanvas(reopened.snapshot.canvas).nodes;
      expect(nodes.find((node) => node.id === boardId)).toMatchObject({
        type: "creative",
        data: { label: "片场灯光草图" },
      });
      const fallback = await settingsFallback();
      for (const [type, expected] of [
        ["character", models.scene],
        ["scene", models.scene],
        ["prop", models.board],
      ]) {
        const node = nodes.find((node) => node.type === "creative" && node.data.label === type);
        expect(node?.type).toBe("creative");
        if (node?.type === "creative")
          expect(node.data.generation?.providerId ?? fallback).toBe(expected);
      }
    } finally {
      await reopened.close();
    }

    async function settingsFallback() {
      return page.evaluate(async () => {
        const list = await window.desktop.settings.list({});
        return list.ok ? list.value.providers[0]?.id : undefined;
      });
    }
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
