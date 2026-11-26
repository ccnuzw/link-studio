import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { readRenderedText } from "../../scripts/read-rendered-text.mjs";
import { addDramaEpisode, createDrama, dramaDocument } from "../../src/main/project/drama";
import { ProjectStore } from "../../src/main/project/store";
import { requireTestValue } from "../require-test-value";

test("资产管理直接拆解：选集不出站，取消中断，重新确认后只锁定所选集并保留道具", async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), "studio-breakdown-")),
    store = await ProjectStore.create(root, "三封信", { projectKind: "drama" }),
    directory = store.directory;
  try {
    const initial = await createDrama(store, {
      title: "三封信",
      script: "第一集 出门\n她带上信封。",
    });
    const second = await addDramaEpisode(store, {
      revision: initial.revision,
      title: "第二集 候车",
      script_md: "",
    });
    await addDramaEpisode(store, {
      revision: second.revision,
      title: "第三集 抵达",
      script_md: "门外有铜铃。",
    });
  } finally {
    await store.close();
  }
  const stages: string[] = [],
    scopes: number[][] = [],
    drafts: string[][] = [];
  let disconnected = false;
  let storyRuns = 0,
    storyAborted = 0;
  const limits: number[] = [];
  let continueOverview: () => void = () => {};
  const overviewGate = new Promise<void>((resolve) => {
    continueOverview = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const prompt = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content as string;
    const stage = prompt.match(/\n# ((?:资产|单集分镜)[^\n]+)/)?.[1] ?? "";
    stages.push(stage);
    const variables = JSON.parse(
      requireTestValue(requireTestValue(prompt.split("```json\n")[1]).split("\n```")[0]),
    );
    if (stage.startsWith("单集分镜") && !stage.includes("格式化")) {
      storyRuns++;
      limits.push(variables.max_seconds);
      if (storyRuns === 1 || storyRuns === 4) {
        response.on("close", () => {
          storyAborted++;
        });
        return;
      }
    }
    if (stage.startsWith("资产拆解创作")) {
      scopes.push(variables.episodes.map((ep: { no: number }) => ep.no));
      drafts.push(variables.episodes.map((ep: { script_md: string }) => ep.script_md));
    }
    if (stages.length === 1) {
      response.on("close", () => {
        disconnected = true;
      });
      return;
    }
    if (stages.length === 6) await overviewGate;
    const asset = {
      type: "prop",
      name: "铜铃",
      look: "",
      description: "门上的铜铃",
      voice_prompt: "",
      aliases: [],
      episodes: scopes.at(-1),
    };
    const text = stage.startsWith("单集分镜格式化")
      ? JSON.stringify({
          segments: [{ seconds: storyRuns === 2 ? 80 : 5, prompt: "镜头停在最后一封信上。" }],
        })
      : stage.startsWith("资产拆解格式化")
        ? JSON.stringify({ assets: [asset] })
        : stage.startsWith("资产图提示词格式化")
          ? JSON.stringify({
              prompts: [{ node_id: variables.assets[0].node_id, prompt: "门上的旧铜铃" }],
            })
          : "门上的旧铜铃";
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("回环端口不可用");
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
    const pricingDraft = await page.evaluate(async (endpoint) => {
      const api = window.desktop.settings,
        channel = await api.channelSave({
          expectedRevision: 0,
          approve: true,
          secret: "local-price",
          fields: {
            name: "回环拆解",
            endpoint,
            allowLocal: true,
            enabled: true,
            sort: 0,
            headers: [],
          },
        });
      if (!channel.ok) throw Error(channel.code);
      const fields = {
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        enabled: true,
        upstreamModel: "priced",
        settings: { api: "chat_completions" as const },
        config: {
          kind: "agent" as const,
          name: "拆解模型",
          description: "",
          sort: 0,
          promptLimit: 24000,
          contextWindow: 32768,
          maxOutputTokens: 2048,
          pricing: { unit: "token" as const, input: 1000, output: 1000 },
        },
      };
      const model = await api.modelSave({ ...fields, expectedRevision: 0 });
      if (!model.ok) throw Error(model.code);
      return { ...fields, id: model.value.id, expectedRevision: model.value.revision };
    }, `http://127.0.0.1:${address.port}`);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, directory);
    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    const tab = page.getByRole("tab", { name: "资产管理", exact: true });
    await tab.click();
    const list = page.getByRole("region", { name: "资产列表" }),
      open = list.getByRole("button", { name: "资产拆解", exact: true }),
      dialog = page.getByRole("dialog", { name: "资产拆解" }),
      submit = dialog.getByRole("button", { name: "开始拆解" });
    const first = dialog.getByRole("button", { name: /^1\.\s*第 1 段/ });
    await open.click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: /第二集 候车/ })).toBeDisabled();
    await dialog.getByRole("button", { name: "全选可用" }).click();
    await expect(dialog.getByText("已选 2 集")).toBeVisible();
    await dialog.getByRole("button", { name: "清空" }).click();
    await expect(dialog.getByRole("button", { name: "至少选一集" })).toBeDisabled();
    await dialog.press("Escape");
    expect(stages).toEqual([]);
    await page
      .getByRole("navigation", { name: "分集" })
      .getByRole("button", { name: /^第 1 集 ·/ })
      .click();
    await expect(list.getByRole("heading", { name: "资产管理 · 第 1 集" })).toBeAttached();
    await open.click();
    const quoted = dialog.getByText(/约\s*\d+\s*积分/);
    await expect(quoted).toBeVisible();
    const firstPrice = Number((await readRenderedText(quoted)).match(/\d+/)?.[0]);
    expect(firstPrice).toBeGreaterThan(0);
    await submit.click();
    await expect(list.getByRole("heading", { name: "资产管理 · 全集" })).toBeAttached();
    const progress = list.getByRole("status");
    await expect(progress).toContainText("拆解第 1 集");
    await expect(open).toBeDisabled();
    await expect.poll(() => scopes).toEqual([[1]]);
    await progress.getByRole("button", { name: "取消" }).click();
    await expect(progress).toHaveCount(0);
    await expect.poll(() => disconnected).toBe(true);
    const studio = page.getByRole("tab", { name: "片场", exact: true }),
      rail = page.getByRole("navigation", { name: "分集" }),
      gate = page.getByRole("region", { name: "片场引导" });
    await studio.click();
    await rail.getByRole("button", { name: /^第 2 集 ·/ }).click();
    await gate.getByRole("button", { name: "去写剧本" }).click();
    await expect(page.getByRole("heading", { name: /^第 2 集 ·/ })).toBeVisible();
    await expect(page.getByLabel("分集剧本", { exact: true })).toBeEditable();
    await studio.click();
    await rail.getByRole("button", { name: /^第 3 集 ·/ }).click();
    await gate.getByRole("button", { name: "去拆解" }).click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await dialog.press("Escape");
    await expect(gate.getByRole("heading")).toHaveText("先拆解第 3 集的资产");
    expect(scopes).toEqual([[1]]);
    await tab.click();
    await list.getByRole("button", { name: "画布", exact: true }).click();
    await open.click();
    await expect(first).toBeEnabled();
    await dialog.press("Escape");
    await studio.click();
    await gate.getByRole("button", { name: "去拆解" }).click();
    await dialog.getByLabel("起始集").fill("3");
    await dialog.getByLabel("结束集").fill("3");
    await dialog.getByRole("button", { name: "选中", exact: true }).click();
    await expect(dialog.getByRole("button", { name: /第三集 抵达/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await submit.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(list.getByRole("heading", { name: "资产管理 · 全集" })).toBeAttached();
    await expect.poll(() => stages.length).toBe(5);
    await expect(open).toBeEnabled();
    await open.click();
    await expect(dialog.getByRole("button", { name: /第三集 抵达/ })).toBeDisabled();
    await expect(first).toBeEnabled();
    await dialog.press("Escape");
    expect(scopes).toEqual([[1], [3]]);
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await page.getByRole("button", { name: /^三封信/ }).click();
    await tab.click();
    await page
      .getByRole("navigation", { name: "分集" })
      .getByRole("button", { name: "全集" })
      .click();
    await list.getByRole("tab", { name: /^道具/ }).click();
    await expect(list.getByRole("listitem", { name: "铜铃" })).toBeVisible();
    await expect(progress).toHaveCount(0);
    expect(stages).toHaveLength(5);
    const overview = page.getByRole("tab", { name: "总览", exact: true }),
      next = page.getByRole("region", { name: "下一步" }),
      breakdown = next.getByRole("button", { name: "拆解", exact: true });
    await overview.click();
    await expect(breakdown).toHaveCount(0);
    await next.getByRole("button", { name: "进片场" }).click();
    await expect(page.getByRole("heading", { name: "第 3 集还没有分镜" })).toBeVisible();
    await overview.click();
    await next.getByRole("button", { name: "去剧本" }).click();
    await expect(page.getByRole("heading", { name: /^第 2 集 ·/ })).toBeVisible();
    await page.getByRole("textbox", { name: "分集剧本" }).fill("站台上的旧信封。");
    await expect(page.locator(".drama-episode-paper>small")).toHaveText("已保存");
    const pill = page.locator(".drama-script-next"),
      fromScript = pill.getByRole("button", { name: "资产拆解" }),
      paper = page.getByRole("textbox", { name: "分集剧本" });
    await expect(fromScript).toBeEnabled();
    await paper.fill("站台上的新信封。");
    await expect(page.locator(".drama-episode-paper>small")).toHaveText("未保存");
    await fromScript.click();
    await expect(dialog).toBeVisible();
    await expect(page.locator(".drama-episode-paper>small")).toHaveText("已保存");
    await dialog.press("Escape");
    await expect(paper).toHaveText("站台上的新信封。");
    expect(stages).toHaveLength(5);
    await overview.click();
    await expect(next).toContainText("2 集剧本已就绪");
    await breakdown.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.press("Escape");
    await expect(overview).toHaveAttribute("aria-selected", "true");
    expect(stages).toHaveLength(5);
    await breakdown.click();
    await expect(quoted).toBeVisible();
    expect(Number((await readRenderedText(quoted)).match(/\d+/)?.[0])).toBe(firstPrice);
    const raised = await page.evaluate(async (fields) => {
      const updated = await window.desktop.settings.modelSave({
        ...fields,
        config: { ...fields.config, pricing: { unit: "token", input: 4000, output: 4000 } },
      });
      if (!updated.ok) throw Error(updated.code);
      return updated.value.revision;
    }, pricingDraft);
    await submit.click();
    await expect(dialog.getByRole("alert")).toContainText("估价已改变");
    expect(stages).toHaveLength(5);
    const newPrice = Number((await readRenderedText(quoted)).match(/\d+/)?.[0]);
    expect(newPrice).toBeGreaterThan(firstPrice);
    await dialog.press("Escape");
    await breakdown.click();
    await expect(quoted).toBeVisible();
    expect(stages).toHaveLength(5);
    await submit.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(list.getByRole("heading", { name: "资产管理 · 全集" })).toBeAttached();
    await expect(progress).toContainText("拆解第 1 集");
    await expect.poll(() => stages.length).toBe(6);
    await studio.click();
    await rail.getByRole("button", { name: /^第 2 集 ·/ }).click();
    await gate.getByRole("button", { name: "去拆解" }).click();
    await expect(first).toBeDisabled();
    await expect(dialog.getByRole("button", { name: /第二集 候车/ })).toBeEnabled();
    await dialog.press("Escape");
    await rail.getByRole("button", { name: /^第 1 集 ·/ }).click();
    await expect(gate.getByRole("heading")).toHaveText("第 1 集的资产还在拆解");
    await expect(gate.getByRole("button")).toHaveCount(1);
    await gate.getByRole("button", { name: "去资产管理" }).click();
    await expect(list.getByRole("heading", { name: "资产管理 · 第 1 集" })).toBeAttached();
    await expect(progress).toContainText("拆解第 1 集");
    expect(stages).toHaveLength(6);
    await page.getByRole("tab", { name: "剧本", exact: true }).click();
    await expect(fromScript).toBeDisabled();
    await expect(pill).toContainText("有进行中的任务：资产拆解 · 第 1 集");
    await overview.click();
    await expect(breakdown).toBeDisabled();
    await expect(breakdown).toHaveAttribute("title", "有进行中的任务：资产拆解 · 第 1 集");
    continueOverview();
    await expect(next).toContainText("1 集剧本已就绪");
    await expect(breakdown).toBeEnabled();
    const disabledRevision = await page.evaluate(
      async ({ id, revision }) => {
        const result = await window.desktop.settings.modelToggle({
          id,
          expectedRevision: revision,
          enabled: false,
        });
        if (!result.ok) throw Error(result.code);
        return result.value.revision;
      },
      { id: pricingDraft.id, revision: raised },
    );
    await breakdown.click();
    const quoteError = dialog.locator(".script-estimate [data-error]");
    await expect(quoteError).toBeVisible();
    const retryQuote = dialog.getByRole("button", { name: "重新估价" });
    await expect(retryQuote).toBeEnabled();
    const requests = stages.length;
    await retryQuote.click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(stages).toHaveLength(requests);
    await dialog.press("Escape");
    const reenabled = await page.evaluate(
      async ({ id, revision }) => {
        const result = await window.desktop.settings.modelToggle({
          id,
          expectedRevision: revision,
          enabled: true,
        });
        if (!result.ok) throw Error(result.code);
        return result.value.revision;
      },
      { id: pricingDraft.id, revision: disabledRevision },
    );
    await page.getByRole("tab", { name: "剧本", exact: true }).click();
    await page
      .getByRole("navigation", { name: "分集" })
      .getByRole("button", { name: /^第 2 集 ·/ })
      .click();
    await paper.fill("站台上的最后一封信。");
    await fromScript.click();
    await expect(dialog.getByRole("button", { name: /第二集 候车/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await submit.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => drafts.at(-1)).toEqual(["站台上的最后一封信。"]);
    await expect(progress).toHaveCount(0);
    await page.getByRole("tab", { name: "剧本", exact: true }).click();
    await expect(pill).toHaveCount(0);
    await studio.click();
    await rail.getByRole("button", { name: /^第 2 集 ·/ }).click();
    const story = page.getByRole("region", { name: "分镜脚本" }),
      generate = story.getByRole("button", { name: /^生成脚本/ });
    await expect(generate).toContainText(/·\d+/);
    const credits = Number(await readRenderedText(generate.locator("b")));
    await generate.dblclick();
    await expect.poll(() => storyRuns).toBe(1);
    await expect(story.getByRole("status")).toContainText("正在生成分镜初稿");
    await rail.getByRole("button", { name: /^第 1 集 ·/ }).click();
    await expect(generate).toBeEnabled();
    await rail.getByRole("button", { name: /^第 2 集 ·/ }).click();
    await story.getByRole("button", { name: "取消" }).click();
    await expect.poll(() => storyAborted).toBe(1);
    await expect(generate).toBeEnabled();
    await generate.click();
    const retry = story.getByRole("button", { name: /重新生成脚本/ });
    await expect(retry).toBeEnabled();
    await retry.click();
    const clip = page
      .getByRole("group", { name: "分镜时间线" })
      .getByRole("button", { name: "片段 1，5 秒", exact: true });
    await expect(clip).toHaveAttribute("title", "镜头停在最后一封信上。");
    await page.getByRole("button", { name: "重新生成分镜脚本", exact: true }).click();
    await expect.poll(() => storyRuns).toBe(4);
    await story.getByRole("button", { name: "取消" }).click();
    await expect.poll(() => storyAborted).toBe(2);
    await expect(clip).toHaveAttribute("title", "镜头停在最后一封信上。");
    expect(limits).toEqual([15, 15, 15, 15]);
    const batchOpen = page.getByRole("button", { name: "批量生成脚本", exact: true }),
      batch = page.getByRole("dialog", { name: "批量生成分镜脚本" });
    await batchOpen.click();
    await expect(batch.getByRole("button", { name: /第二集 候车/ })).toHaveAttribute(
      "title",
      "已有分镜",
    );
    await expect(batch.getByRole("button", { name: "至少选一集" })).toBeDisabled();
    await batch.getByRole("button", { name: "全选可用" }).click();
    await expect(batch.getByText("已选 2 集")).toBeVisible();
    await batch.press("Escape");
    expect(storyRuns).toBe(4);
    await rail.getByRole("button", { name: /^第 1 集 ·/ }).click();
    await batchOpen.click();
    await expect(batch.getByRole("button", { name: /^1\./ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const price = batch.locator(".script-estimate small b");
    await expect(price).toBeVisible();
    const oldPrice = Number(await readRenderedText(price));
    await page.evaluate(
      async ({ fields, expectedRevision }) => {
        const result = await window.desktop.settings.modelSave({
          ...fields,
          expectedRevision,
          config: { ...fields.config, pricing: { unit: "token", input: 8000, output: 8000 } },
        });
        if (!result.ok) throw Error(result.code);
      },
      { fields: pricingDraft, expectedRevision: reenabled },
    );
    await batch.getByLabel("起始集").fill("3");
    await batch.getByLabel("结束集").fill("1");
    await batch.getByRole("button", { name: "选中", exact: true }).click();
    await expect(price).toBeVisible();
    const thirdPrice = Number(await readRenderedText(price)) - oldPrice;
    await batch.getByRole("button", { name: "生成 2 集脚本" }).dblclick();
    await expect(batch).toHaveCount(0);
    await expect(page.getByText(/^有 1 集没能提交：第 1 集/)).toBeVisible();
    await expect.poll(() => storyRuns).toBe(5);
    await batchOpen.click();
    await expect(price).toBeVisible();
    const retryPrice = Number(await readRenderedText(price));
    expect(retryPrice).toBeGreaterThan(oldPrice);
    const batchPrice = retryPrice + thirdPrice;
    await batch.getByRole("button", { name: "生成 1 集脚本" }).click();
    await expect(batch).toHaveCount(0);
    await expect.poll(() => storyRuns).toBe(6);
    await expect(page.getByText(/已提交 \d+ 集分镜脚本|有 1 集没能提交/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重新生成分镜脚本" })).toBeVisible();
    await rail.getByRole("button", { name: /^第 3 集 ·/ }).click();
    await expect(page.getByRole("button", { name: "重新生成分镜脚本" })).toBeVisible();
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    const reopened = await ProjectStore.open(directory);
    try {
      const doc = requireTestValue(dramaDocument(reopened.snapshot));
      expect(
        doc.jobs
          ?.filter((job) => job.step === "breakdown")
          .map((job) => [job.status, job.episodes]),
      ).toEqual([
        ["canceled", [1]],
        ["succeeded", [3]],
        ["succeeded", [1]],
        ["succeeded", [2]],
      ]);
      expect(doc.jobs?.[0]?.frozen_credits).toBe(firstPrice);
      expect(doc.jobs?.[2]?.frozen_credits).toBe(newPrice);
      expect(doc.episodes.filter((ep) => ep.locked).map((ep) => ep.episode_no)).toEqual([1, 2, 3]);
      expect(
        doc.jobs
          ?.filter((job) => job.step === "storyboard" && job.episodes.includes(2))
          .map((job) => [job.status, job.episodes, job.frozen_credits]),
      ).toEqual(
        ["canceled", "failed", "succeeded", "canceled"].map((status) => [status, [2], credits]),
      );
      const batchJobs = requireTestValue(doc.jobs).filter(
        (job) => job.step === "storyboard" && !job.episodes.includes(2),
      );
      expect(batchJobs.map((job) => job.episodes[0]).sort()).toEqual([1, 3]);
      expect(batchJobs.every((job) => job.status === "succeeded")).toBe(true);
      expect(batchJobs.reduce((sum, job) => sum + job.frozen_credits, 0)).toBe(batchPrice);
      expect(doc.segments).toHaveLength(3);
      expect(doc.episodes[1]?.storyboard_status).toBe("ready");
    } finally {
      await reopened.close();
    }
  } finally {
    continueOverview();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (app) {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      });
      await app.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("长剧片场批量分镜限制 50 集，估价失败允许重试，取消后没有任务", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-batch-limit-"));
  const store = await ProjectStore.create(root, "末班车", { projectKind: "drama" }),
    directory = store.directory;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    try {
      await createDrama(store, { title: "末班车", script: "站台钟响了。" });
      await store.updateGeneration((state) => {
        const doc = requireTestValue(dramaDocument(state)),
          first = requireTestValue(doc.episodes[0]);
        doc.episodes = Array.from({ length: 52 }, (_, index) => ({
          ...first,
          episode_no: index + 1,
          title: `站台${index + 1}`,
          locked: true,
        }));
        return { changed: true, result: null };
      });
    } finally {
      await store.close();
    }
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
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, directory);
    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    await page.getByRole("tab", { name: "片场", exact: true }).click();
    await page.getByRole("button", { name: "批量生成脚本", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "批量生成分镜脚本" });
    await dialog.getByRole("button", { name: "全选可用" }).click();
    await expect(dialog.getByRole("button", { name: "生成 50 集脚本" })).toBeEnabled();
    await dialog.getByLabel("结束集").fill("52");
    await dialog.getByRole("button", { name: "选中", exact: true }).click();
    await expect(dialog.getByText("已选 52 集")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "一次最多 50 集" })).toBeDisabled();
    await dialog.getByLabel("起始集").fill("51");
    await dialog.getByRole("button", { name: "选中", exact: true }).click();
    await expect(dialog.locator(".script-estimate [data-error]")).toContainText(/第 5[12] 集/);
    await dialog.getByRole("button", { name: "生成 2 集脚本" }).click();
    await expect(dialog.getByRole("alert")).toContainText(/第 51 集.*第 52 集/);
    await expect(dialog.getByRole("button", { name: "生成 2 集脚本" })).toBeEnabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    const reopened = await ProjectStore.open(directory);
    try {
      expect(requireTestValue(dramaDocument(reopened.snapshot)).jobs ?? []).toEqual([]);
    } finally {
      await reopened.close();
    }
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
