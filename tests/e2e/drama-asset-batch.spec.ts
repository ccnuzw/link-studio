import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { applyCanvas, projectCanvas } from "../../src/main/project/canvas";
import { createDrama } from "../../src/main/project/drama";
import { mergeDramaAssets } from "../../src/main/project/drama-assets";
import { ProjectStore } from "../../src/main/project/store";
import { requireTestValue } from "../require-test-value";
import { projectAction } from "./workspace-actions";

test("短剧资产：框选不提交，全集预选跨集，失败重试不重复成功项，形象完成后生成音色", async () => {
  test.setTimeout(75_000);
  const root = await mkdtemp(join(tmpdir(), "drama-asset-batch-")),
    store = await ProjectStore.create(root, "两把钥匙"),
    directory = store.directory;
  try {
    await createDrama(store, {
      title: "两把钥匙",
      script: "第一集 找锁\n有人敲门。\n第二集 开门\n灯光亮了。",
    });
    await store.updateGeneration((state) => {
      mergeDramaAssets(
        state,
        [
          ["prop", "铜钥匙", 1],
          ["prop", "铁钥匙", 2],
          ["prop", "门锁", 1],
          ["character", "守门人", 1],
          ["character", "访客", 1],
        ].map(([type, name, no]) => ({
          type: type as "character" | "prop",
          name: String(name),
          episodes: [Number(no)],
          look: "",
          description: "",
          aliases: [],
          voice_prompt: name === "守门人" ? "沙哑男声" : "",
        })),
      );
      state.canvas = applyCanvas(
        state,
        projectCanvas(state.canvas).nodes.flatMap((node) =>
          node.type !== "creative"
            ? []
            : [
                {
                  type: "putNode" as const,
                  node: { ...node, data: { ...node.data, text: `${node.data.label}的特写` } },
                },
              ],
        ),
      );
      state.canvas = applyCanvas(state, [
        {
          type: "putNode",
          node: {
            id: "uploaded-prop",
            type: "creative",
            position: { x: 0, y: 2000 },
            data: {
              kind: "image",
              label: "自供图",
              text: "不应提交",
              uploaded: true,
              uploadFailed: true,
              drama: {
                type: "prop",
                name: "自供图",
                look: "",
                description: "",
                episodes: [2],
                aliases: [],
              },
            },
          },
        },
        {
          type: "putNode",
          node: {
            id: "unclassified-role",
            type: "creative",
            position: { x: 0, y: 2400 },
            data: {
              kind: "image",
              label: "未归类",
              text: "不应提交",
              character: { name: "未归类", look: "", description: "", extraAssetIds: [] },
            },
          },
        },
      ]);
      return { changed: true, result: null };
    });
  } finally {
    await store.close();
  }
  const png = (await readFile(join(process.cwd(), "resources/icons/icon-32.png"))).toString(
    "base64",
  );
  const audio = Buffer.from(
    "T2dnUwACAAAAAAAAAACgCKTfAAAAAGIERBUBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAKAIpN8BAAAAvcMZTQE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAyAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMiBsaWJvcHVzT2dnUwAEOBAAAAAAAACgCKTfAgAAAJcZJUsFAwMDAwP4//74//74//74//74//4=",
    "base64",
  );
  const requests: string[] = [],
    voices: { text_prompt: string; references: unknown[] }[] = [];
  let endpoint = "",
    release: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === "/voice.ogg") {
      response.writeHead(200, { "content-type": "application/ogg" }).end(audio);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === "/api/v3/tts/create") {
      voices.push(body);
      response.end(JSON.stringify({ code: 0, url: `${endpoint}/voice.ogg` }));
      return;
    }
    if (request.url !== "/v1/images/generations") {
      response.writeHead(404).end();
      return;
    }
    requests.push(body.prompt);
    const send = () => response.end(JSON.stringify({ data: [{ b64_json: png }] }));
    if (
      body.prompt === "铁钥匙的特写" &&
      requests.filter((name) => name === body.prompt).length === 1
    )
      response.writeHead(400).end(JSON.stringify({ error: { message: "铁钥匙需要再试一次" } }));
    else if (body.prompt === "守门人的特写") release = send;
    else send();
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("缺少测试端口");
    endpoint = `http://127.0.0.1:${address.port}`;
    const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: root };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    app = await electron.launch({
      ...(executablePath
        ? { executablePath, args: [] }
        : { args: [process.env.LINK_STUDIO_E2E_APP ?? "."] }),
      env,
    });
    const page = await app.firstWindow();
    await page.evaluate(async (endpoint) => {
      function requireTestValue<Value>(value: Value): NonNullable<Value> {
        if (value === null || value === undefined) throw new Error("测试页面缺少预期值");
        return value;
      }

      const list = await window.desktop.settings.list({});
      if (!list.ok) throw Error(list.code);
      for (const [key, model] of [
        ["openai-image", "gpt-image-1"],
        ["doubao-audio", "seed-audio-1.0"],
      ] as const) {
        const plugin = requireTestValue(list.value.plugins.find((item) => item.key === key));
        if (key === "openai-image") {
          const api = window.desktop.settings,
            channel = await api.channelSave({
              expectedRevision: 0,
              approve: true,
              fields: {
                name: "出图渠道",
                endpoint,
                enabled: true,
                allowLocal: true,
                sort: 0,
                headers: [],
              },
            });
          if (!channel.ok) throw Error(channel.code);
          const keys = await api.channelKeys({
            id: channel.value.id,
            expectedRevision: channel.value.revision,
            secret: "fixture",
          });
          if (!keys.ok) throw Error(keys.code);
          const image = await api.modelSave({
            expectedRevision: 0,
            approve: true,
            channelId: keys.value.id,
            channelRevision: keys.value.revision,
            enabled: true,
            upstreamModel: model,
            pluginHash: plugin.hash,
            settings: {},
            config: {
              kind: "image",
              name: "场记图",
              description: "",
              sort: 0,
              pricing: { unit: "request", input: 4 },
            },
          });
          if (!image.ok) throw Error(image.code);
          continue;
        }
        const saved = await window.desktop.settings.save({
          expectedRevision: 0,
          pluginHash: plugin.hash,
          approve: true,
          secret: "fixture",
          fields: {
            label: model,
            model,
            endpoint,
            allowLocal: true,
            agentEnabled: false,
            channel: key === "doubao-audio" ? { as: "base64" } : {},
          },
        });
        if (!saved.ok) throw Error(saved.code);
      }
    }, endpoint);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, directory);
    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    await projectAction(page, "短剧工作室");
    const assets = page.getByRole("tab", { name: "资产管理", exact: true }),
      list = page.getByRole("region", { name: "资产列表" }),
      rail = page.getByRole("navigation", { name: "分集" });
    const type = (name: string) => list.getByRole("tab", { name: new RegExp(`^${name}`) }),
      card = (name: string) => list.getByRole("listitem", { name, exact: true }),
      ep = (no: number) => rail.getByRole("button", { name: new RegExp(`^第 ${no} 集 ·`) });
    const all = list.getByRole("button", { name: "全部生成" }),
      bar = list.getByRole("toolbar", { name: "批量操作" });
    await assets.click();
    await ep(1).click();
    await type("道具").click();
    await expect(list.locator("[data-asset-id]")).toHaveCount(2);
    const drag = async (name: string) => {
      const box = await card(name).boundingBox();
      if (!box) throw Error("卡片不可见");
      await page.mouse.move(box.x - 4, box.y - 4);
      await page.mouse.down();
      await page.mouse.move(box.x + 12, box.y + 12, { steps: 5 });
      await expect(list.locator(".drama-asset-marquee")).toBeVisible();
      await page.mouse.up();
    };
    await drag("铜钥匙");
    await expect(bar).toContainText("已选 1 个");
    await page.keyboard.down("Shift");
    try {
      await drag("门锁");
    } finally {
      await page.keyboard.up("Shift");
    }
    await expect(bar).toContainText("已选 2 个");
    const check = card("门锁").getByRole("button", { name: /^(取消选择|选择)$/ });
    await check.focus();
    await page.keyboard.press("Space");
    await expect(check).toHaveAttribute("aria-pressed", "false");
    await expect(bar).toContainText("已选 1 个");
    await page.keyboard.press("Space");
    await expect(check).toHaveAttribute("aria-pressed", "true");
    await expect(bar).toContainText("已选 2 个");
    await expect(list.getByRole("button", { name: "列表", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await card("铜钥匙").getByRole("button", { name: "取消选择" }).click();
    await bar.getByRole("button", { name: "全选" }).click();
    await expect(bar).toContainText("已选 2 个");
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    expect(requests).toEqual([]);
    await all.click();
    await expect(bar).toContainText("已选 3 个");
    await bar.getByRole("button", { name: "生成 3 个 · 约 12 积分起" }).click();
    await expect(card("铜钥匙")).toHaveAttribute("data-status", "done");
    await expect(card("门锁")).toHaveAttribute("data-status", "done");
    await ep(2).click();
    await expect(card("铁钥匙")).toHaveAttribute("data-status", "error");
    await all.click();
    await expect(bar).toContainText("已选 1 个");
    await expect(card("自供图").getByRole("button", { name: "选择", exact: true })).toHaveCount(0);
    await bar.getByRole("button", { name: /生成 1 个/ }).click();
    await expect(card("铁钥匙")).toHaveAttribute("data-status", "done");
    expect([...requests].sort()).toEqual(
      ["铜钥匙的特写", "铁钥匙的特写", "门锁的特写", "铁钥匙的特写"].sort(),
    );
    await expect(all).toHaveCount(0);
    await ep(1).click();
    await type("角色").click();
    await all.click();
    await bar.getByRole("button", { name: /生成（含音色）/ }).click();
    await expect(card("守门人")).toHaveAttribute("data-status", "running");
    await expect.poll(() => typeof release).toBe("function");
    expect(voices).toEqual([]);
    requireTestValue(release)();
    release = undefined;
    await expect(card("访客")).toHaveAttribute("data-status", "done");
    await expect(card("守门人").getByLabel("已设定音色")).toBeVisible();
    expect(voices).toHaveLength(1);
    expect(voices[0]?.text_prompt).toBe("沙哑男声");
    expect(voices[0]?.references).toEqual([{ image_data: png }]);
    await rail.getByRole("button", { name: "全集" }).click();
    await expect(card("未归类")).toBeVisible();
    await expect(all).toHaveCount(0);
    await drag("守门人");
    await expect(card("守门人").getByRole("button", { name: "取消选择" })).toBeVisible();
    await expect(card("未归类").getByRole("button", { name: "选择", exact: true })).toHaveCount(0);
    await bar.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "返回画布" }).click();
    await projectAction(page, "关闭项目");
    await page.getByRole("button", { name: /^两把钥匙/ }).click();
    await projectAction(page, "短剧工作室");
    await assets.click();
    await expect(card("守门人").getByLabel("已设定音色")).toBeVisible();
    await expect(card("访客")).toHaveAttribute("data-status", "done");
    await type("道具").click();
    await rail.getByRole("button", { name: "全集" }).click();
    await expect(list.locator("[data-status=done]")).toHaveCount(3);
    await expect(all).toHaveCount(0);
  } finally {
    release?.();
    server.closeAllConnections();
    server.close();
    if (app) {
      await app.evaluate(({ app }) => {
        setImmediate(() => app.exit(0));
      });
      await app.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});
