import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page, test } from "@playwright/test";
import { openStore } from "../../packages/agent-runtime/upstream/src/store/store";
import type { ProjectState } from "../../packages/link-studio-core/src/project";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { projectCanvas } from "../../src/main/project/canvas";
import { ProjectStore } from "../../src/main/project/store";
import { SettingsRegistry } from "../../src/main/settings/registry";
import {
  chooseAssistantModel,
  expectAssistantContrast,
  expectAssistantPicker,
  expectDraft,
  expectReadableModelHover,
} from "./assistant-theme";
import { compactViewport, desktopElectron as electron } from "./desktop-window";
import {
  chooseCanvasZoom,
  clickBlankCanvas,
  createCanvasProject,
  editTextNode,
  projectAction,
} from "./workspace-actions";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=";

test("旧工程结果未知：任务中心区分缺少原绑定和仍可查询的回执", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-recheck-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.end(JSON.stringify({ status: "failed", error: { message: "回环任务已过期" } }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("回环服务不可用");
    const store = await ProjectStore.create(root, "复查验收");
    const registry = await SettingsRegistry.open(
      join(root, "settings"),
      "resources/provider-plugins",
      "out/provider-runtime/runner",
      { encrypt: Buffer.from, decrypt: (bytes) => Buffer.from(bytes).toString() },
    );
    try {
      const plugin = await registry.draft(
        registry.agentPlugin("doubao-video").code +
          "\nmodule.exports.meta.key='recheck-video';module.exports.meta.auth={type:'none'};",
      );
      const model = registry.save({
        expectedRevision: 0,
        approve: true,
        pluginHash: plugin.hash,
        fields: {
          label: "原供应商",
          model: "fixture",
          endpoint: `http://127.0.0.1:${address.port}`,
          allowLocal: true,
          channel: {},
          agentEnabled: false,
        },
      });
      await store.updateGeneration((state) => {
        for (const missing of [true, false]) {
          const id = randomUUID(),
            providerId = missing ? randomUUID() : model.id;
          state.jobs[id] = {
            version: 1,
            id,
            providerId,
            providerLabel: "原供应商",
            model: missing ? "绑定缺失" : "绑定可用",
            kind: "video",
            nodeId: id,
            input: {
              nodeId: id,
              providerId,
              expectedProviderRevision: model.revision,
              expectedCanvasRevision: 1,
              prompt: "样例",
              referenceAssetIds: [],
            },
            providerTaskId: "receipt",
            pluginHash: plugin.hash,
            status: "outcome_unknown",
            error: "JOB_OUTCOME_UNKNOWN",
            canRecheck: true,
            canCancelRemote: false,
            createdAt: state.createdAt,
            updatedAt: state.createdAt,
            outputs: [],
            progress: 0,
          };
        }
        return { changed: true, result: null };
      });
      await mkdir(join(root, "projects"), { recursive: true });
      await writeFile(
        join(root, "projects", "recent.json"),
        JSON.stringify([
          {
            recentEntryId: randomUUID(),
            projectId: store.projectId,
            directory: store.directory,
            displayName: store.name,
            displayPath: store.directory,
            lastOpenedAt: new Date().toISOString(),
          },
        ]),
      );
    } finally {
      registry.close();
      await store.close();
    }
    const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: root };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    app = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env,
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /^复查验收/ }).click();
    await projectAction(page, "生成任务");
    const center = page.getByRole("region", { name: "生成任务中心" });
    const blocked = center.getByRole("article").filter({ hasText: "绑定缺失" });
    const available = center.getByRole("article").filter({ hasText: "绑定可用" });
    for (const viewport of [{ width: 1280, height: 800 }, compactViewport]) {
      await page.setViewportSize(viewport);
      await expect(blocked.getByText(/请到原供应商核对结果/)).toBeVisible();
      await expect(blocked.getByRole("button", { name: "查询原任务" })).toHaveCount(0);
      await expect(blocked).toContainText("结果未知");
      await expect(available.getByRole("button", { name: "查询原任务" })).toBeEnabled();
    }
    expect(calls).toEqual([]);
    await available.getByRole("button", { name: "查询原任务" }).click();
    await expect(available).toContainText("回环任务已过期");
    expect(calls).toEqual(["GET /api/v3/contents/generations/tasks/receipt"]);
  } finally {
    await app?.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("画布连线作为视频参考，断线与文生模式不发送原图", async () => {
  test.setTimeout(55_000);
  const root = await mkdtemp(join(tmpdir(), "link-studio-linked-video-"));
  const filename = "镜头参考.png";
  const nodeLabel = "镜头参考";
  const file = join(root, filename);
  const bytes = Buffer.from(png, "base64");
  const submissions: { type: string; body: Buffer }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && /^\/v1\/videos\/fixture-[12]$/.test(request.url ?? "")) {
      response.end(
        JSON.stringify(
          request.url?.endsWith("fixture-1")
            ? { status: "cancelled" }
            : { status: "canceled", error: { message: "镜头时长不受支持" } },
        ),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/videos") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    submissions.push({ type: request.headers["content-type"] ?? "", body: Buffer.concat(chunks) });
    response.end(JSON.stringify({ id: `fixture-${submissions.length}` }));
  });
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await writeFile(file, bytes);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing mock endpoint");
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    const env = {
      ...process.env,
      LINK_STUDIO_TEST_USER_DATA: root,
      LINK_STUDIO_TEST_PROJECT_PARENT: root,
      LINK_STUDIO_TEST_MEDIA_FILES: file,
    };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env,
    });
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const page = await application.firstWindow();
    const historyModelKey = await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      if (!list.ok) throw new Error(list.code);
      const plugin = list.value.plugins.find(({ key }) => key === "sora");
      if (!plugin) throw new Error("Missing Sora adapter");
      const saved = await settings.save({
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-video-key",
        fields: {
          label: "回环视频",
          model: "sora-2",
          endpoint,
          allowLocal: true,
          agentEnabled: false,
          channel: {},
        },
      });
      if (!saved.ok) throw new Error(saved.code);
      return saved.value.modelKey ?? saved.value.id;
    }, `http://127.0.0.1:${address.port}`);
    await createCanvasProject(page, "连线参考验收");
    await page.getByRole("button", { name: /^视频生成 文生、参考/ }).click();
    const video = page
      .locator(".react-flow__node")
      .filter({ has: page.locator("header strong").filter({ hasText: /^视频$/ }) });
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    await page.getByRole("button", { name: `将${filename}加入画布` }).click();
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    const image = page.locator(".react-flow__node").filter({ hasText: nodeLabel });
    const heading = video.locator("header strong");
    const bounds = await image.locator(".node-media").boundingBox();
    const source = await image.locator(".react-flow__handle-right").boundingBox();
    const destination = await video.locator(".react-flow__handle-left").boundingBox();
    if (!bounds || !source || !destination) throw new Error("缺少初始节点或端口");
    await page.mouse.move(bounds.x + 30, bounds.y + 30);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 30 + destination.x - source.x - 64, bounds.y + 30, {
      steps: 12,
    });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const right = await image.locator(".react-flow__handle-right").boundingBox();
        const left = await video.locator(".react-flow__handle-left").boundingBox();
        return !!right && !!left && right.x < left.x;
      })
      .toBe(true);
    await chooseCanvasZoom(page, "适应画布");
    await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.locator(".react-flow__viewport").evaluate(async (viewport) => {
          const initial = getComputedStyle(viewport).transform;
          await new Promise((done) => setTimeout(done, 120));
          return getComputedStyle(viewport).transform === initial;
        }),
      )
      .toBe(true);
    await image
      .locator(".react-flow__handle-right")
      .dragTo(video.locator(".react-flow__handle-left"), { steps: 12 });
    const edge = page.locator(".react-flow__edge");
    await expect(edge).toHaveCount(1);
    await heading.click();
    const composer = page.getByRole("region", { name: "生成确认" });
    const reference = composer.getByRole("button", {
      name: `引用：${nodeLabel}，点击定位到节点`,
      exact: true,
    });
    const removeReference = composer.getByRole("button", { name: `断开「${nodeLabel}」的引用` });
    const modeTabs = composer.getByRole("tablist", { name: "生成方式" });
    const imageMode = modeTabs.getByRole("tab", { name: "图生视频" });
    const textMode = modeTabs.getByRole("tab", { name: "文生视频" });
    const prompt = composer.getByRole("textbox", { name: "生成提示词" });
    await expect(imageMode).toHaveAttribute("aria-selected", "true");
    await expect(textMode).toHaveAttribute("title", "已有参考素材，文生视频不可用");
    await expect(reference).toBeVisible();
    const addReference = composer.getByRole("button", { name: "引用画布里的素材" });
    await addReference.click();
    const picker = page.getByRole("menu", { name: "引用画布里的素材" });
    await expect(picker.getByText("画布里没有能接进来的素材")).toBeVisible();
    await expect(picker.getByRole("menuitem", { name: nodeLabel })).toHaveCount(0);
    const upload = picker.getByRole("menuitem", { name: /上传参考素材/ });
    const chooser = page.waitForEvent("filechooser");
    await upload.click();
    await (await chooser).setFiles(join(process.cwd(), "resources/icons/icon-32.png"));
    const manual = composer.getByRole("button", { name: "移除这份素材" });
    await expect(manual).toBeVisible();
    const overflow = composer
      .getByRole("alert")
      .filter({ hasText: "参考图片最多 1 个，请移除多余的" });
    const generate = composer.getByRole("button", { name: "开始生成" });
    await prompt.fill("镜头缓慢推进");
    await expect(overflow).toBeVisible();
    await expect(generate).toBeDisabled();
    await prompt.press("Control+Enter");
    expect(submissions).toHaveLength(0);
    const targetId = await video.getAttribute("data-id");
    const directory = join(
      root,
      (await readdir(root)).find((name) => name.endsWith(".linkstudio"))!,
      "state",
    );
    const readManual = async () => {
      const latest = (await readdir(directory)).sort().at(-1)!;
      const snapshot: ProjectState = JSON.parse(await readFile(join(directory, latest), "utf8"));
      const node = projectCanvas(snapshot.canvas).nodes.find((node) => node.id === targetId);
      const ids = node?.type === "creative" ? (node.data.manualReferenceIds ?? []) : [];
      return ids.map((id) => snapshot.assets[id]?.displayName);
    };
    await expect.poll(readManual).toEqual(["icon-32.png"]);
    await expect(textMode).toBeDisabled();
    await textMode.press("Enter");
    await expect(imageMode).toHaveAttribute("aria-selected", "true");
    await expect(manual).toBeVisible();
    await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
    await heading.click();
    await page.keyboard.press("Escape");
    await expect(composer).toBeHidden();
    await heading.click();
    await expect(manual).toBeVisible();
    await manual.click();
    await expect(manual).toHaveCount(0);
    await expect(overflow).toHaveCount(0);
    await expect(
      composer.getByText("参考图片最多 1 个，请移除多余的", { exact: true }),
    ).toHaveCount(0);
    await expect(generate).toBeEnabled();
    await prompt.fill("");
    await expect.poll(readManual).toEqual([]);
    await expect(edge).toHaveCount(1);
    await removeReference.click();
    await expect(edge).toHaveCount(0);
    await expect(imageMode).toHaveAttribute("title", "需要连接图片节点");
    await textMode.click();
    await addReference.click();
    await expect(upload).toHaveCount(0);
    await picker.getByRole("menuitem", { name: nodeLabel }).click();
    await expect(picker).toBeHidden();
    await expect(edge).toHaveCount(1);
    await expect(imageMode).toHaveAttribute("aria-selected", "true");
    await expect(prompt).toHaveText("");
    await addReference.click();
    await expect(addReference).toHaveAttribute("aria-expanded", "true");
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(composer).toBeVisible();

    const sourceId = await image.getAttribute("data-id");
    const menu = page.getByRole("listbox", { name: "引用画布里的素材" });
    const chip = prompt.locator(`[data-ref="${sourceId}"]`);
    await prompt.fill("镜头缓慢推进 ");
    await page.keyboard.insertText("@");
    await expect(menu.getByText("已引用", { exact: true })).toBeVisible();
    await prompt.press("Escape");
    await expect(menu).toBeHidden();
    await prompt.press("Backspace");
    await removeReference.click();
    await expect(edge).toHaveCount(0);
    await prompt.click();
    await prompt.press("End");
    await page.keyboard.insertText("@");
    await expect(menu.getByText("画布中 · 选中后自动连线")).toBeVisible();
    await page.keyboard.insertText("镜头");
    await expect(menu.getByRole("option", { name: new RegExp(nodeLabel) })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await prompt.press("Enter");
    await expect(edge).toHaveCount(1);
    await expect(chip).toHaveText(nodeLabel);
    await expect(chip).toHaveAttribute("data-gone", "false");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(edge).toHaveCount(0);
    await expect(prompt).toHaveText("镜头缓慢推进 ");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(edge).toHaveCount(1);
    await expect(chip).toHaveText(nodeLabel);
    const preview = page.getByRole("img", { name: `${nodeLabel} 的大图` });
    await expect(chip.locator("img")).toHaveAttribute("src", /^link-media:/);
    await chip.hover();
    await expect(preview).toHaveCount(1);
    await expect(preview).toBeVisible();
    await expect(image).toHaveClass(/ref-hl/);
    await expect
      .poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(2);
    await page.mouse.wheel(0, 80);
    await expect(preview).toBeHidden();
    await heading.hover();
    await expect(image).not.toHaveClass(/ref-hl/);
    await chip.hover();
    await expect(preview).toBeVisible();
    await heading.hover();
    await expect(preview).toBeHidden();
    await reference.focus();
    await page.keyboard.press("Tab");
    await expect(removeReference).toBeFocused();
    await expect(preview).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(composer).toBeVisible();
    await reference.hover();
    await expect(preview).toBeVisible();
    await expect(chip).toHaveAttribute("data-lit", "true");
    await expect(image).toHaveClass(/ref-hl/);
    const viewport = page.locator(".react-flow__viewport");
    const transform = await viewport.evaluate((el) => el.style.transform);
    await reference.click();
    await expect.poll(() => viewport.evaluate((el) => el.style.transform)).not.toBe(transform);
    await expect(video).toHaveClass(/selected/);
    await expect(edge).toHaveCount(1);
    await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
    await removeReference.click();
    await expect(edge).toHaveCount(0);
    await heading.click();
    await expect(reference).toBeHidden();
    await expect(prompt).toHaveText("镜头缓慢推进");
    await expect(imageMode).toHaveAttribute("aria-selected", "true");
    await expect(imageMode).toBeDisabled();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(edge).toHaveCount(1);
    await heading.click();
    await expect(reference).toBeVisible();
    await expect(chip).toHaveText(nodeLabel);
    await expect(textMode).toBeDisabled();
    await expect.poll(() => submissions.length).toBe(0);
    await imageMode.click();
    await expect(reference).toBeVisible();
    await composer.getByRole("button", { name: "开始生成" }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]?.type).toMatch(/^multipart\/form-data;/);
    expect(submissions[0]?.body.toString().match(/name="input_reference"/g)).toHaveLength(1);
    expect(submissions[0]?.body.includes(bytes)).toBe(true);
    expect(submissions[0]?.body.toString()).toContain("镜头缓慢推进 图片1");

    const jobs = page.getByRole("region", { name: "生成任务中心" });
    await projectAction(page, "生成任务");
    await expect(jobs.getByText("失败", { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(jobs.getByText("任务详情 · Sora 任务失败：cancelled")).toBeVisible();
    await page.getByRole("button", { name: "关闭侧栏" }).click();
    const resultNotice = page.locator(".pet-request").getByRole("button", { name: /^生成失败/ });
    await resultNotice.hover();
    await expect(resultNotice).toContainText("Sora 任务失败：cancelled");
    const beforeLocate = await viewport.evaluate((element) => element.style.transform);
    await resultNotice.click();
    await expect(jobs).toBeHidden();
    await expect
      .poll(() => viewport.evaluate((element) => element.style.transform))
      .not.toBe(beforeLocate);
    await expect(video).toBeInViewport();
    await heading.click();
    await removeReference.click();
    await expect(edge).toHaveCount(0);
    await textMode.click();
    await composer.getByRole("button", { name: "开始生成" }).click();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions[1]?.type).toMatch(/^application\/json/);
    expect(JSON.parse(submissions[1]?.body.toString() ?? "{}")).toEqual({
      model: "sora-2",
      prompt: "镜头缓慢推进",
    });
    await projectAction(page, "生成任务");
    await expect(jobs.getByText("失败", { exact: true })).toHaveCount(2, { timeout: 25_000 });
    await expect(jobs.getByText("任务详情 · 镜头时长不受支持")).toBeVisible();
    await page.getByRole("button", { name: "关闭侧栏" }).click();
    await page.getByRole("button", { name: "任务历史" }).click();
    const history = page.getByRole("dialog", { name: "任务历史" }),
      rows = history.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(historyModelKey);
    await expect(rows.first()).toContainText("失败");
    await rows.first().getByRole("button").click();
    await expect(history).toHaveCount(0);
    await expect(video).toHaveClass(/selected/);
    await clickBlankCanvas(page);
    await expect(video).not.toHaveClass(/selected/);
    await page.getByRole("button", { name: "失败节点 1 个" }).click();
    await expect(video).toHaveClass(/selected/);
  } finally {
    await application?.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const [followMode, title] of [
  ["follow", "S4 设置与画布小灵隔离，审批生成和结果跨重启保留"],
  ["cancel", "画布小灵：跨重启取消后台跟进，生成仍完成"],
  ["steer", "画布小灵：结果插进进行中的对话，不另开一轮"],
  ["notices", "画布小灵：授权后仅后台实时审批与自动验收发系统通知"],
  ["reject", "画布小灵：拒绝生成并说明原因，不提交或跟进"],
  ["submit-only", "画布小灵：只提交生成，不登记后台跟进"],
] as const)
  test(title, async () => {
    test.setTimeout(65_000);
    const root = await mkdtemp(join(tmpdir(), "link-studio-generation-e2e-"));
    const clipPath = join(root, "测试镜头.mp4");
    await runMediaProcess(
      join(process.cwd(), "out/media", `${process.platform}-${process.arch}`, "ffmpeg"),
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=24:d=1",
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "1",
        clipPath,
      ],
    );
    let imageCalls = 0;
    let imageRequest: { size?: string; quality?: string; n?: number; prompt?: string } | undefined;
    let nextTool: { name: string; args: object } | undefined;
    let prepareVariant = false,
      variantId = "",
      laterId = "";
    let allowedTools: string[] = [];
    let asyncSubmits = 0;
    let submittedPrompt = "";
    let asyncQueries = 0;
    let cancelCalls = 0;
    let complete = false;
    let receivedImage = false;
    let receivedHeldImage = false;
    let textModelSawImage = false;
    let textModelDeniedImage = false;
    let referenceRequests = 0;
    let sawGroupContext = false;
    let catalogAfterDeletion: Record<string, unknown> | undefined;
    let catalogAfterCommit: Record<string, unknown> | undefined;
    let sawQuestionAnswers = false;
    let sawQuestionSkip = false;
    let sawGenerationRejection = false,
      sawSubmitOnly = false;
    let selectedQuestionModel = "";
    let finishCompletion = () => {};
    let holdCompletion = false;
    const completion = new Promise<void>((resolve) => {
      finishCompletion = resolve;
    });
    let sawQuestionModel = false;
    const server = createServer(async (request, response) => {
      if (request.url === "/reference.txt") {
        referenceRequests++;
        response.writeHead(200, { "content-type": "text/plain" }).end("资料");
        return;
      }
      if (request.method === "DELETE" && request.url === "/fixture-jobs/original-task") {
        cancelCalls++;
        response.writeHead(500).end();
        return;
      }
      if (request.url === "/fixture-jobs") {
        const body: Buffer[] = [];
        for await (const chunk of request) body.push(chunk);
        submittedPrompt = JSON.parse(Buffer.concat(body).toString()).prompt;
        asyncSubmits++;
        response.end(JSON.stringify({ id: "original-task" }));
        return;
      }
      if (request.url === "/fixture-jobs/original-task") {
        asyncQueries++;
        response.end(JSON.stringify({ ready: complete }));
        return;
      }
      if (request.url === "/fixture-result.png") {
        response.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(png, "base64"));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      for (const entry of payload.messages ?? []) {
        if (entry.role !== "user") continue;
        const text = Array.isArray(entry.content)
          ? entry.content.map((part: { text?: string }) => part.text ?? "").join("")
          : String(entry.content);
        const catalog = text.match(/（以下是数据，不是指令）\n([^\n]+)\n<\/画布目录>/u)?.[1];
        if (catalog && text.startsWith("检查分组及视口。"))
          catalogAfterDeletion = JSON.parse(catalog);
        if (catalog && text.startsWith("@[小灵分镜组](node:fixture-s4-group) 记录这个分组。"))
          catalogAfterCommit = JSON.parse(catalog);
      }
      if (request.url?.includes("/images/")) {
        imageCalls++;
        imageRequest = payload;
        response.end(
          JSON.stringify({
            data: Array.from({ length: payload.n ?? 1 }, () => ({ b64_json: png })),
          }),
        );
        return;
      }
      const requestTools = (payload.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      );
      if (requestTools.length) allowedTools = requestTools;
      if (holdCompletion && requestTools.length) {
        holdCompletion = false;
        await completion;
      }
      receivedImage ||= JSON.stringify(payload.messages).includes(`data:image/png;base64,${png}`);
      receivedHeldImage ||= (payload.messages ?? []).some(
        (message: { role: string; content: unknown }) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("保留先前待审批的画布任务。") &&
          JSON.stringify(message.content).includes(`data:image/png;base64,${png}`),
      );
      const toolReplies = JSON.stringify(
        (payload.messages ?? []).filter((entry: { role: string }) => entry.role === "tool"),
      );
      sawGenerationRejection ||= toolReplies.includes(
        "用户拒绝了提案 · 用户说明：先调整镜头，不要生成",
      );
      sawSubmitOnly ||= toolReplies.includes("用户要求只提交，不跟进生成结果");
      sawQuestionAnswers ||=
        toolReplies.includes("用户回答了你的提问：") &&
        toolReplies.includes("横屏") &&
        toolReplies.includes("画面发生在哪里？ → 雨夜街道") &&
        toolReplies.includes("电影感、冷色调") &&
        toolReplies.includes("2.5") &&
        toolReplies.includes("未回答");
      sawQuestionSkip ||= toolReplies.includes(
        "用户没有回答这些问题，改发了新消息；请以用户的新消息为准，确有必要再问。",
      );
      sawQuestionModel ||=
        Boolean(selectedQuestionModel) &&
        toolReplies.includes(`用户回答：gpt-image-1（模型 key：${selectedQuestionModel}）`);
      sawGroupContext ||= (payload.messages ?? []).some(
        (message: { role: string; content: unknown }) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes("fixture-s4-group") &&
          JSON.stringify(message.content).includes("viewport"),
      );
      if (payload.model === "fixture-text") {
        const messages = JSON.stringify(payload.messages);
        textModelSawImage ||= messages.includes("data:image/");
        textModelDeniedImage ||=
          !allowedTools.includes("canvas_inspect_image") &&
          !allowedTools.includes("canvas_inspect_video");
      }
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (prepareVariant && requestTools.length && !nextTool) {
        const last = payload.messages?.at(-1);
        if (
          last?.role === "tool" &&
          typeof last.content === "string" &&
          last.content.includes("variant")
        ) {
          const created = JSON.parse(last.content).created;
          variantId = created.variant;
          laterId = created.later;
          nextTool = {
            name: "generate_media",
            args: {
              items: [{ nodeId: variantId }],
              reason: "为镜头准备另一种光线。",
              ...(followMode === "submit-only" && { wait: false }),
            },
          };
          prepareVariant = false;
        }
      }
      const call = requestTools.length ? nextTool : undefined;
      if (call) {
        nextTool = call.name === "canvas_get_state" ? afterRead : undefined;
        response.write(
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: call.name,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          }),
        );
      } else {
        const instruction = JSON.stringify(payload.messages?.[0]);
        const content = instruction.includes("会话命名助手")
          ? "开场画面创作"
          : instruction.includes("操作总结助手")
            ? "已核对画布操作"
            : "画布任务已检查。";
        response.write(chunk({ role: "assistant", content }));
      }
      response.end(`${chunk({}, call ? "tool_calls" : "stop")}data: [DONE]\n\n`);
    }).listen(0, "127.0.0.1");
    let afterRead: typeof nextTool;
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing mock endpoint");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    const environment = {
      ...process.env,
      LINK_STUDIO_TEST_MEDIA_FILES: clipPath,
      LINK_STUDIO_TEST_USER_DATA: root,
      LINK_STUDIO_TEST_PROJECT_PARENT: root,
    };
    delete (environment as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const launch = () =>
      electron.launch({
        ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
        env: environment,
      });
    let application: Awaited<ReturnType<typeof launch>> | undefined;
    const jobs = (page: Page) => page.getByRole("region", { name: "生成任务中心" });
    try {
      application = await launch();
      const page = await application.firstWindow();
      const profiles = await page.evaluate(async (endpoint) => {
        const settings = window.desktop.settings;
        const list = await settings.list({});
        if (!list.ok) throw new Error(list.code);
        for (const [key, label, agentEnabled, agentVision] of [
          ["openai-image", "回环图片", false, false],
          ["sora", "回环视频", false, false],
          ["openai", "回环小灵", true, true],
          ["openai", "回环文本小灵", true, false],
        ] as const) {
          const plugin = list.value.plugins.find((entry) => entry.key === key);
          if (!plugin) throw new Error(`Missing ${key}`);
          const saved = await settings.save({
            expectedRevision: 0,
            pluginHash: plugin.hash,
            approve: true,
            secret: "fixture-secret",
            fields: {
              label,
              endpoint,
              model:
                key === "openai-image"
                  ? "gpt-image-1"
                  : key === "sora"
                    ? "sora-2"
                    : !agentVision
                      ? "fixture-text"
                      : "fixture",
              allowLocal: true,
              agentEnabled,
              agentVision,
              channel: agentEnabled ? { api: "chat_completions" } : {},
            },
          });
          if (!saved.ok) throw new Error(saved.code);
        }
        const fixture = await settings.draft({
          source: `module.exports = {
        meta: { apiVersion: 1, key: 'fixture-async-image', name: '回环异步图片', auth: { type: 'none' }, endpoints: { image: { mode: 'async' } }, poll: { firstDelay: 0.01, interval: 1 } },
        buildSubmitRequest: function (ctx) { return { method: 'POST', path: '/fixture-jobs', json: {prompt:ctx.input.prompt} }; },
        parseSubmitResponse: function (ctx, resp) { return { providerTaskId: resp.body.id }; },
        buildQueryRequest: function (ctx) { return { method: 'GET', path: '/fixture-jobs/' + ctx.task.providerTaskId }; },
        parseQueryResponse: function (ctx, resp) { return resp.body.ready ? { status: 'succeeded', outputs: [{ type: 'url', url: ctx.channel.baseUrl + '/fixture-result.png' }] } : { status: 'running' }; },
        buildCancelRequest: function (ctx) { return { method: 'DELETE', path: '/fixture-jobs/' + ctx.task.providerTaskId }; }
      };`,
        });
        if (!fixture.ok) throw new Error(fixture.code);
        const saved = await settings.save({
          expectedRevision: 0,
          pluginHash: fixture.value.hash,
          approve: true,
          fields: {
            label: "回环异步图片",
            endpoint,
            model: "async-fixture",
            allowLocal: true,
            agentEnabled: false,
            channel: {},
          },
        });
        if (!saved.ok) throw new Error(saved.code);
        return saved.value;
      }, endpoint);
      if (followMode === "follow") await page.setViewportSize(compactViewport);
      await createCanvasProject(page, "生成闭环验收");
      await page.getByRole("button", { name: /^图片生成 文字或参考图/ }).click();
      const imageNode = page
        .locator(".react-flow__node")
        .filter({ has: page.locator("header strong").filter({ hasText: /^图片$/ }) });
      await clickBlankCanvas(page);
      await expect(page.getByRole("region", { name: "生成确认" })).toBeHidden();
      await imageNode.locator(".node-media").click({ position: { x: 30, y: 30 } });
      await expect(page.getByRole("region", { name: "生成确认" })).toBeVisible();
      const modelTrigger = page.getByRole("button", { name: "选择模型", exact: true });
      await modelTrigger.press("Enter");
      const models = page.getByRole("menu", { name: "选择模型" });
      const asyncModel = models.getByRole("menuitemradio", { name: /async-fixture/ });
      await asyncModel.click();
      await expect(asyncModel).toHaveAttribute("aria-checked", "true");
      await expect(modelTrigger).toHaveText("async-fixture");
      await models.getByRole("menuitemradio", { name: /gpt-image-1.*回环图片/ }).click();
      await expect(modelTrigger).toHaveText("gpt-image-1");
      await page.keyboard.press("Escape");
      await expect(models).toBeHidden();
      await expect(modelTrigger).toBeFocused();
      const parametersTrigger = page.getByRole("button", { name: "生成参数", exact: true });
      await parametersTrigger.click();
      const parameters = page.getByRole("region", { name: "生成参数", exact: true });
      const highQuality = parameters.getByRole("radio", { name: "高", exact: true });
      await highQuality.click();
      await expect(highQuality).toBeChecked();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "放大编辑提示词" }).click();
      const expanded = page.getByRole("dialog", { name: "编辑提示词" });
      const expandedPrompt = expanded.getByRole("textbox", { name: "生成提示词" });
      await expandedPrompt.fill("模型切换保留草稿");
      const switchToAsync = async () => {
        await expect(models).toBeHidden();
        await expanded.getByRole("button", { name: "选择模型" }).click();
        await asyncModel.click();
      };
      await switchToAsync();
      const warning = page.getByRole("dialog", { name: "切换模型" });
      await expect(warning).toContainText("新模型没有这些参数，切换后会被丢弃：画质。");
      await warning.getByRole("button", { name: "取消", exact: true }).press("Escape");
      await expect(warning).toBeHidden();
      await expect(expanded.getByRole("button", { name: "选择模型" })).toHaveText("gpt-image-1");
      await switchToAsync();
      await warning.getByRole("button", { name: "继续切换" }).click();
      await expect(expanded.getByRole("button", { name: "选择模型" })).toHaveText("async-fixture");
      await expect(expandedPrompt).toHaveText("模型切换保留草稿");
      await expect(models).toBeHidden();
      await expanded.getByRole("button", { name: "选择模型" }).click();
      await models.getByRole("menuitemradio", { name: /gpt-image-1.*回环图片/ }).click();
      await page.keyboard.press("Escape");
      await expandedPrompt.fill("");
      await expandedPrompt.press("Escape");
      await expect(expanded).toBeHidden();
      await parametersTrigger.click();
      await expect(highQuality).not.toBeChecked();
      await parameters.getByRole("radio", { name: "3:2", exact: true }).click();
      await highQuality.click();
      await parameters.getByRole("combobox", { name: "生成数量" }).selectOption("2");
      await page.keyboard.press("Escape");
      await expect(parameters).toBeHidden();
      await expect(parametersTrigger).toBeFocused();
      const templateTrigger = page.getByRole("button", { name: "提示词模板", exact: true });
      await templateTrigger.click();
      await page.getByRole("button", { name: /25宫格连贯分镜/ }).click();
      await expect(page.getByText("此模板需要一张参考图。")).toBeVisible();
      const editor = page.getByRole("textbox", { name: "生成提示词" });
      await editor.locator('[data-preset^="tpl/"]').click();
      await page.getByRole("button", { name: /25宫格连贯分镜/ }).click();
      await expect(editor.locator("[data-preset]")).toHaveCount(0);
      await editor.fill("给封面生成一张图片");
      await editor.press("End");
      await page.getByRole("button", { name: "风格", exact: true }).click();
      const style = page.getByRole("button", { name: "古装偶像", exact: true });
      await expect
        .poll(() => style.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0);
      await page.screenshot({ path: "test-results/canvas-node-style-picker.png" });
      const gridItems = page.locator(".media-preset-grid [data-preset-item]");
      const columns = await gridItems
        .first()
        .evaluate(
          (item) => getComputedStyle(item.parentElement!).gridTemplateColumns.split(" ").length,
        );
      await style.focus();
      await style.press("ArrowDown");
      await expect(gridItems.nth(columns)).toBeFocused();
      await gridItems.nth(columns).press("ArrowUp");
      await expect(style).toBeFocused();
      await style.press("Enter");
      await expect(editor.locator("[data-preset]")).toHaveText("古装偶像");
      await expect(editor).toBeFocused();
      await page.screenshot({ path: "test-results/canvas-node-generation.png" });
      await page.getByRole("button", { name: "开始生成" }).click();
      await projectAction(page, "生成任务");
      await expect(jobs(page).getByText("已完成", { exact: true })).toHaveCount(1);
      expect(imageRequest).toMatchObject({
        size: "1536x1024",
        quality: "high",
        n: 2,
        prompt: expect.stringMatching(/^给封面生成一张图片，古偶唯美柔光风格/),
      });
      await expect(imageNode.locator('.node-media img[src^="link-media:"]')).toBeVisible();
      await page
        .getByRole("toolbar", { name: /的功能区$/ })
        .getByRole("button", { name: "加入资产库" })
        .click();
      const destination = page.getByRole("dialog", { name: "加入资产库" });
      await destination.getByRole("button", { name: "加入", exact: true }).click();
      await expect(destination).toHaveCount(0);
      await page.getByRole("button", { name: "资产库", exact: true }).click();
      const assetPicker = page.getByRole("dialog", { name: "资产库" });
      await expect(
        assetPicker.locator('.asset-pick-card[data-source="library"][data-kind="image"]'),
      ).toHaveCount(1);
      await assetPicker.getByRole("tab", { name: "生成历史" }).click();
      await assetPicker.getByRole("textbox", { name: "搜索提示词" }).fill("古偶唯美柔光");
      await expect(assetPicker.getByRole("button", { name: /^给封面生成一张图片/ })).toHaveCount(2);
      await assetPicker
        .getByRole("button", { name: /^给封面生成一张图片/ })
        .first()
        .click();
      await assetPicker.getByRole("tab", { name: "个人资产库" }).click();
      await assetPicker.getByRole("list", { name: "已选素材" }).getByRole("button").click();
      await expect(assetPicker.getByRole("button", { name: "确认", exact: true })).toBeDisabled();
      await assetPicker.getByRole("button", { name: "关闭", exact: true }).click();
      const nodeId = await imageNode.getAttribute("data-id");
      if (!nodeId) throw new Error("Missing canvas node ID");
      const readRevision = () =>
        import("node:fs/promises").then(async ({ readdir, readFile }) => {
          const project = (await readdir(root)).find((name) => name.endsWith(".linkstudio"));
          if (!project) throw new Error("Missing workspace");
          const directory = join(root, project, "state");
          const file = (await readdir(directory)).sort().at(-1);
          if (!file) throw new Error("Missing snapshot");
          return Number(JSON.parse(await readFile(join(directory, file), "utf8")).canvas.revision);
        });
      nextTool = { name: "canvas_get_state", args: { nodeIds: [nodeId] } };
      prepareVariant = true;
      afterRead = {
        name: "canvas_apply_ops",
        args: {
          ops: [
            {
              op: "create_node",
              kind: "image",
              tempId: "variant",
              label: "另一版",
              prompt: "生成另一版",
              model: profiles.id,
            },
            {
              op: "create_node",
              kind: "image",
              tempId: "later",
              label: "下一版",
              prompt: "关闭前未审批的任务",
              model: profiles.id,
            },
            {
              op: "create_node",
              kind: "script",
              tempId: "lighting",
              label: "光线设定",
              prompt: "落日从左侧照入",
            },
            { op: "connect", source: "lighting", target: "variant" },
          ],
        },
      };
      await page.getByRole("button", { name: "打开小灵", exact: true }).click();
      const canvasAssistant = page.getByRole("region", { name: "画布小灵" });
      await expect(
        canvasAssistant.getByRole("button", { name: "新对话", exact: true }),
      ).toBeEnabled();
      await expectAssistantContrast(
        canvasAssistant.getByRole("button", { name: "新对话", exact: true }),
      );
      await expect(canvasAssistant.getByRole("log")).toHaveCSS("color-scheme", "light");
      await expect(
        canvasAssistant.getByRole("button", { name: "发送", exact: true }),
      ).toBeDisabled();
      const canvasModel = canvasAssistant.getByRole("button", { name: "Agent 模型" });
      await chooseAssistantModel(canvasModel, { name: "fixture" });
      await expectAssistantPicker(canvasModel);
      await expectReadableModelHover(canvasModel);
      const mediaPicker = canvasAssistant.getByRole("button", { name: "插入模型" });
      const canvasComposer = canvasAssistant.getByRole("textbox", { name: "画布消息" });
      const message =
        followMode === "submit-only"
          ? "请为这个节点生成另一版，只提交就行。"
          : "请为这个节点生成另一版。";
      const imageGhost = canvasComposer.locator(".agent-editor-ghost");
      await expect(imageGhost).toHaveText("图片");
      await canvasComposer.click();
      const imageReference = canvasComposer.locator(".agent-editor-chip[data-kind=node]");
      await expect(imageReference).toHaveText("图片");
      await page.keyboard.insertText(message);
      await canvasComposer.press("End");
      await mediaPicker.press("Enter");
      const menu = page.getByRole("dialog", { name: "插入模型" });
      const row = menu.getByRole("button", { name: /gpt-image-1/ });
      await expect(row).toBeVisible();
      await expect
        .poll(async () => {
          const anchor = await mediaPicker.boundingBox(),
            popup = await menu.boundingBox();
          return (
            !!anchor &&
            !!popup &&
            Math.abs(anchor.y - popup.y - popup.height - 8) <= 1 &&
            anchor.x >= popup.x - 1 &&
            anchor.x < popup.x + popup.width
          );
        })
        .toBe(true);
      await menu.getByRole("radio", { name: "视频" }).check();
      await expect(row).toHaveCount(0);
      await menu.getByRole("button", { name: /sora-2/ }).click();
      await menu.getByRole("radio", { name: "图片" }).check();
      await row.click();
      await expect(canvasAssistant.locator(".agent-editor-chip[data-kind=model]")).toHaveCount(2);
      await page.emulateMedia({ colorScheme: "dark" });
      await canvasAssistant.screenshot({ path: test.info().outputPath("canvas-model-menu.png") });
      await page.emulateMedia({ colorScheme: null });
      await row.press("Escape");
      await expect(menu).toHaveCount(0);
      const contextRing = canvasAssistant.getByRole("button", { name: "上下文用量 0 / 33K" });
      await contextRing.click();
      await expect(
        canvasAssistant.getByText("快满时会自动压缩较早的对话，不影响继续使用"),
      ).toBeVisible();
      await contextRing.press("Escape");
      await canvasAssistant.locator(".assistant-composer").screenshot({
        path: test.info().outputPath("canvas-composer.png"),
      });
      await expectAssistantContrast(canvasComposer);
      await expectAssistantContrast(imageReference);
      await canvasComposer.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
      await canvasComposer.press("Shift+Enter");
      await expectDraft(canvasComposer, `@图片 ${message}@sora-2 @gpt-image-1 \n`);
      await expectAssistantContrast(
        canvasAssistant.getByRole("button", { name: "发送", exact: true }),
      );
      await canvasComposer.press("Enter");
      const approval = page.getByRole("heading", { name: "申请生成 1 个节点" });
      await expect(approval).toBeVisible({ timeout: 15000 });
      await expect(canvasAssistant.locator(".agent-user-bubble [data-kind=model]")).toHaveText([
        "sora-2",
        "gpt-image-1",
      ]);
      await canvasAssistant.getByRole("button", { name: "关闭小灵" }).click();
      const reminder = page.getByRole("button", { name: "这一步要你点个头" });
      await expect(reminder).toBeVisible();
      await expect(page).toHaveTitle("⏸ 待批准 · 生成闭环验收 - 灵可 · Link Studio");
      expect(asyncSubmits).toBe(0);
      await reminder.click();
      await expect(approval).toBeVisible();
      await canvasComposer.press("Escape");
      await expect(approval).toBeVisible();
      await expect(canvasModel).toBeDisabled();
      await expectAssistantContrast(canvasModel);
      await expectAssistantContrast(approval);
      await expectAssistantContrast(canvasAssistant.locator(".generation-label").first());
      const requestDetails = canvasAssistant
        .locator("details")
        .filter({ has: page.getByText("查看端点和出站内容", { exact: true }) });
      await requestDetails.locator("summary").click();
      const providerAddress = requestDetails
        .locator("section p")
        .filter({ hasText: endpoint })
        .first();
      await expect(providerAddress).toBeVisible();
      await expectAssistantContrast(providerAddress);
      await requestDetails.locator("summary").click();
      await page.emulateMedia({ contrast: "more" });
      await expectAssistantContrast(canvasAssistant.locator(".generation-items small").first());
      await page.emulateMedia({ contrast: null });
      expect(allowedTools).not.toContain("admin_propose_changes");
      expect(allowedTools).toEqual(expect.arrayContaining(["plan_update", "show_card"]));
      expect(imageCalls).toBe(1);
      expect(asyncSubmits).toBe(0);
      if (followMode === "reject") {
        await canvasAssistant.getByRole("button", { name: "添加附件" }).click();
        await page
          .getByRole("dialog", { name: "添加附件" })
          .getByLabel("上传图片")
          .setInputFiles({
            name: "审批参考.png",
            mimeType: "image/png",
            buffer: Buffer.from(png, "base64"),
          });
        await canvasAssistant.getByRole("textbox", { name: "画布消息" }).click();
      }
      await page.getByRole("textbox", { name: "画布消息" }).fill("保留先前待审批的画布任务。");
      await page.getByRole("button", { name: "插话", exact: true }).click();
      await expect(page.getByText("保留先前待审批的画布任务。", { exact: true })).toBeVisible();
      expect(asyncSubmits).toBe(0);
      await expect(
        canvasAssistant.getByText("为镜头准备另一种光线。", { exact: true }),
      ).toBeVisible();
      const selected = canvasAssistant.getByRole("checkbox");
      const approve = canvasAssistant.getByRole("option", { name: /批准生成/ });
      const permission = (target: Page) =>
        target.evaluate(async () => {
          const result = await window.desktop.settings.agentNoticePermission({});
          return result.ok ? result.value.permission : result.code;
        });
      const consent = canvasAssistant.getByRole("region", { name: "后台生成通知" });
      await expect(consent).toHaveCount(0);
      await expect(selected).toBeChecked();
      await selected.uncheck();
      await expect(approve).toBeDisabled();
      if (followMode === "reject") {
        await expect(canvasAssistant.getByRole("region", { name: "等待读取的插话" })).toContainText(
          "1 张图",
        );
        const explain = canvasAssistant.getByRole("option", { name: /告诉 Agent 怎么改/ });
        await explain.click();
        const input = canvasAssistant.getByRole("textbox", { name: /告诉 Agent 怎么改/ });
        await input.press("Escape");
        await expect(explain).toBeFocused();
        await explain.press("Enter");
        await input.fill("先调整镜头，不要生成");
        await input.press("Enter");
        await expect(
          canvasAssistant
            .getByRole("log")
            .getByText("已拒绝：申请生成 1 个节点 · 你的说明：先调整镜头，不要生成", {
              exact: true,
            }),
        ).toBeVisible();
        await expect.poll(() => sawGenerationRejection).toBe(true);
        await expect.poll(() => receivedHeldImage).toBe(true);
        await expect(consent).toHaveCount(0);
        expect(await permission(page)).toBe("default");
        expect(asyncSubmits).toBe(0);
        await expect(canvasAssistant.getByRole("region", { name: "后台等待生成" })).toHaveCount(0);
        return;
      }
      await selected.check();
      await approve.click();
      if (followMode === "notices" || followMode === "steer" || followMode === "submit-only") {
        await consent
          .getByRole("button", {
            name: followMode === "submit-only" ? "不允许" : "允许通知",
            exact: true,
          })
          .click();
        await expect(consent).toHaveCount(0);
        expect(await permission(page)).toBe(followMode === "submit-only" ? "denied" : "granted");
      }
      await expect.poll(() => asyncQueries).toBeGreaterThan(0);
      expect(submittedPrompt).toBe("生成另一版\n\n落日从左侧照入");
      await expect(
        canvasAssistant.getByRole("log").getByText("已批准：申请生成 1 个节点", { exact: true }),
      ).toBeVisible();
      const watch = canvasAssistant.getByRole("region", { name: "后台等待生成" });
      if (followMode === "submit-only") {
        await expect.poll(() => sawSubmitOnly).toBe(true);
        await expect(watch).toHaveCount(0);
        await expect(page).toHaveTitle("生成闭环验收 - 灵可 · Link Studio");
        complete = true;
        await projectAction(page, "生成任务");
        await expect(jobs(page).getByText("已完成", { exact: true })).toHaveCount(2, {
          timeout: 20000,
        });
        const database = new DatabaseSync(join(root, "settings", "agent.sqlite"), {
          readOnly: true,
        });
        try {
          expect(
            database
              .prepare(
                "SELECT type FROM agent_events WHERE type IN ('watch.updated','tasks.settled')",
              )
              .all(),
          ).toEqual([]);
        } finally {
          database.close();
        }
        expect(asyncSubmits).toBe(1);
        expect(cancelCalls).toBe(0);
        return;
      }
      await watch.getByRole("button", { name: "后台等待生成 · 0/1 已结束" }).press("Enter");
      await expect(page).toHaveTitle("⏳ 0/1 · 生成闭环验收 - 灵可 · Link Studio");
      await expect(watch.getByRole("list")).toContainText("生成中");
      await watch.getByRole("button", { name: "另一版", exact: true }).click();
      await expect(page.locator(".react-flow__node.selected")).toHaveAttribute(
        "data-id",
        variantId,
      );
      await expect
        .poll(() => page.locator(".canvas-area").evaluate((area) => area.clientHeight))
        .toBe(
          await page.locator(".canvas-workspace").evaluate((workspace) => workspace.clientHeight),
        );
      await projectAction(page, "生成任务");
      await expect(jobs(page).getByText("生成中", { exact: true })).toHaveCount(1);
      await application.evaluate(({ dialog }) => {
        const choices = [0, 2, 1];
        const prompts: Electron.MessageBoxOptions[] = [];
        Reflect.set(globalThis, "s4QuitPrompts", prompts);
        dialog.showMessageBox = (async (options: Electron.MessageBoxOptions) => {
          prompts.push(options);
          return { response: choices.shift() ?? 1, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
      });
      await application.evaluate(({ app }) => app.quit());
      const prompts = await application.evaluate(
        () => Reflect.get(globalThis, "s4QuitPrompts") as Electron.MessageBoxOptions[],
      );
      expect(prompts).toMatchObject([
        {
          message: "还有 1 项生成任务未完成",
          buttons: ["继续等待", "退出并稍后恢复", "请求取消任务"],
        },
      ]);
      expect(cancelCalls).toBe(0);
      await expect(jobs(page).getByText("生成中", { exact: true })).toBeVisible();
      await application.evaluate(({ app }) => app.quit());
      await expect.poll(() => cancelCalls).toBe(1);
      await expect(jobs(page).getByText("JOB_CANCEL_UNCONFIRMED", { exact: false })).toBeVisible();
      await expect(jobs(page).getByText("生成中", { exact: true })).toBeVisible();
      await application.close();
      const queriesBeforeRestart = asyncQueries;
      if (followMode === "cancel") {
        const databasePath = join(root, "settings", "agent.sqlite");
        const database = new DatabaseSync(databasePath, { readOnly: true });
        let sessionId: string;
        try {
          const watches = database
            .prepare(
              "SELECT CAST(session_id AS TEXT) AS id FROM agent_events WHERE type='watch.updated'",
            )
            .all();
          expect(watches).toHaveLength(1);
          sessionId = String(watches[0]!.id);
        } finally {
          database.close();
        }
        const store = openStore(databasePath, { workerId: 3 });
        try {
          const { canvasId, mode } = store.getSession("1", sessionId);
          for (let index = 1; index <= 55; index++) {
            const run = store.createRun({
              sessionId,
              canvasId,
              mode,
              userId: "1",
              status: "completed",
            });
            store.appendEvent(sessionId, run.id, "message.user", {
              text: `等待期间的问题 ${index}`,
            });
            store.appendEvent(sessionId, run.id, "message.done", {
              text: `等待期间的回复 ${index}`,
            });
          }
        } finally {
          store.close();
        }
      }
      application = await launch();
      const reopened = await application.firstWindow();
      if (followMode === "notices" || followMode === "steer") {
        await application.evaluate(({ Notification }) => {
          const delivered: Electron.Notification[] = [];
          Reflect.set(globalThis, "nativeNotices", delivered);
          Notification.prototype.show = function () {
            delivered.push(this);
          };
        });
      }
      await reopened.getByRole("button", { name: /^生成闭环验收/ }).click();
      await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
      const restored = reopened.getByRole("region", { name: "后台等待生成" });
      await expect(
        restored.getByRole("button", { name: "后台等待生成 · 0/1 已结束" }),
      ).toBeVisible();
      await expect(reopened).toHaveTitle("⏳ 0/1 · 生成闭环验收 - 灵可 · Link Studio");
      if (followMode === "notices") {
        const app = application;
        const owner = await app.browserWindow(reopened);
        const titles = () =>
          app.evaluate(() =>
            (Reflect.get(globalThis, "nativeNotices") as Electron.Notification[]).map(
              (notice) => notice.title,
            ),
          );
        const hide = async () => {
          await owner.evaluate((win) => win.hide());
          await expect.poll(() => owner.evaluate((win) => win.isVisible())).toBe(false);
          expect(await permission(reopened)).toBe("granted");
        };
        const clickLatest = async () => {
          await app.evaluate(() =>
            (Reflect.get(globalThis, "nativeNotices") as Electron.Notification[])
              .at(-1)!
              .emit("click", {}),
          );
          await expect.poll(() => owner.evaluate((win) => win.isVisible())).toBe(true);
        };
        await hide();
        expect(await titles()).toEqual([]);
        complete = true;
        const settledTitle = "生成闭环验收：生成已完成，Agent 正在验收";
        await expect.poll(titles, { timeout: 20_000 }).toEqual([settledTitle]);
        await clickLatest();
        await expect(
          reopened.getByRole("separator", { name: "生成全部结束 · Agent 自动继续" }),
        ).toBeVisible();
        await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
        nextTool = { name: "canvas_get_state", args: { nodeIds: [laterId] } };
        afterRead = { name: "generate_media", args: { items: [{ nodeId: laterId }] } };
        holdCompletion = true;
        await reopened.getByRole("textbox", { name: "画布消息" }).fill("提出一项生成任务。");
        await reopened.getByRole("button", { name: "发送", exact: true }).click();
        await expect.poll(() => holdCompletion).toBe(false);
        await hide();
        finishCompletion();
        await expect.poll(titles).toEqual([settledTitle, "生成闭环验收：Agent 需要你批准一批生成"]);
        await clickLatest();
        await expect(reopened.getByRole("heading", { name: "申请生成 1 个节点" })).toBeVisible();
        return;
      }
      if (followMode === "steer") {
        const owner = await application.browserWindow(reopened);
        holdCompletion = true;
        await reopened.getByRole("textbox", { name: "画布消息" }).fill("先聊一下新镜头。");
        await reopened.getByRole("button", { name: "发送", exact: true }).click();
        await expect.poll(() => holdCompletion).toBe(false);
        await owner.evaluate((win) => win.hide());
        expect(await permission(reopened)).toBe("granted");
        complete = true;
        const log = reopened.getByRole("log");
        await expect(log.getByRole("separator", { name: "生成全部结束 · 插进这一轮" })).toBeVisible(
          { timeout: 20000 },
        );
        finishCompletion();
        expect(
          await application.evaluate(
            () => (Reflect.get(globalThis, "nativeNotices") as Electron.Notification[]).length,
          ),
        ).toBe(0);
        await owner.evaluate((win) => win.show());
        await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
        await expect(
          log.getByRole("separator", { name: "生成全部结束 · Agent 自动继续" }),
        ).toHaveCount(0);
        const database = new DatabaseSync(join(root, "settings", "agent.sqlite"), {
          readOnly: true,
        });
        try {
          const deliveries = database
            .prepare(
              "SELECT CAST(run_id AS TEXT) AS run, json_extract(payload,'$.steer') AS steer FROM agent_events WHERE type='tasks.settled'",
            )
            .all();
          const chat = database
            .prepare(
              "SELECT CAST(run_id AS TEXT) AS run FROM agent_events WHERE type='message.user' AND json_extract(payload,'$.text')=?",
            )
            .get("先聊一下新镜头。");
          expect(chat).toBeDefined();
          expect(deliveries).toEqual([{ run: chat!.run, steer: 1 }]);
        } finally {
          database.close();
        }
        return;
      }
      if (followMode === "cancel") {
        await expect(
          reopened.getByRole("log").getByText("等待期间的问题 55", { exact: true }),
        ).toBeVisible();
        await expect(
          reopened.getByRole("log").getByText("等待期间的问题 1", { exact: true }),
        ).toHaveCount(0);
        const priorCancelCalls = cancelCalls;
        await restored.getByRole("button", { name: "不用等了" }).press("Enter");
        await expect(restored).toHaveCount(0);
        await expect(reopened).toHaveTitle("生成闭环验收 - 灵可 · Link Studio");
        const watches = new DatabaseSync(join(root, "settings", "agent.sqlite"), {
          readOnly: true,
        });
        try {
          const states = () =>
            watches
              .prepare(
                "SELECT json_extract(payload,'$.state') AS state FROM agent_events WHERE type='watch.updated' ORDER BY seq",
              )
              .all()
              .map((row) => row.state);
          expect(states()).toEqual(["waiting", "canceled"]);
          complete = true;
          await projectAction(reopened, "生成任务");
          await expect(jobs(reopened).getByText("已完成", { exact: true })).toHaveCount(2, {
            timeout: 20000,
          });
          expect(asyncSubmits).toBe(1);
          expect(cancelCalls).toBe(priorCancelCalls);
          await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
          await expect(reopened.getByRole("separator", { name: /生成全部结束/ })).toHaveCount(0);
          expect(states()).toEqual(["waiting", "canceled"]);
        } finally {
          watches.close();
        }
        return;
      }
      complete = true;
      await expect(
        reopened.getByRole("separator", { name: "生成全部结束 · Agent 自动继续" }),
      ).toHaveCount(1, {
        timeout: 20_000,
      });
      const disclosure = reopened.getByRole("button", { name: "查看生成结果详情" });
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await disclosure.press("Enter");
      await expect(reopened.getByRole("region", { name: "生成结果详情" })).toContainText("已完成");
      await reopened.getByRole("button", { name: "定位节点", exact: true }).click();
      await expect(reopened.locator(".react-flow__node.selected")).toHaveAttribute(
        "data-id",
        variantId,
      );
      await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      await chooseAssistantModel(reopened.getByRole("button", { name: "Agent 模型" }), {
        name: "fixture",
      });
      nextTool = { name: "canvas_get_state", args: { nodeIds: [variantId] } };
      afterRead = { name: "canvas_inspect_image", args: { nodeId: variantId } };
      await reopened.getByRole("textbox", { name: "画布消息" }).fill("查看生成的图片。");
      await reopened.getByRole("button", { name: "发送", exact: true }).click();
      await expect.poll(() => receivedImage, { timeout: 10_000 }).toBe(true);
      await expect(
        reopened.getByRole("button", { name: "历史会话，当前：开场画面创作" }),
      ).toBeVisible();
      const activity = reopened.getByRole("button", { name: "已核对画布操作", exact: true }).last();
      await expect(activity).toHaveAttribute("aria-expanded", "false");
      await activity.press("Enter");
      await expect(activity).toHaveAttribute("aria-expanded", "true");
      await projectAction(reopened, "生成任务");
      await expect(jobs(reopened).getByText("已完成", { exact: true })).toHaveCount(2);
      expect(imageCalls).toBe(1);
      expect(asyncSubmits).toBe(1);
      expect(asyncQueries).toBeGreaterThan(queriesBeforeRestart);
      await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
      await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      await chooseAssistantModel(reopened.getByRole("button", { name: "Agent 模型" }), {
        name: "fixture-text",
      });
      nextTool = { name: "canvas_get_state", args: { nodeIds: [nodeId] } };
      afterRead = { name: "canvas_inspect_image", args: { nodeId } };
      await reopened.getByRole("textbox", { name: "画布消息" }).fill("用文本模型尝试查看图片。");
      await reopened.getByRole("button", { name: "发送", exact: true }).click();
      await expect.poll(() => textModelDeniedImage).toBe(true);
      expect(textModelSawImage).toBe(false);
      await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      await projectAction(reopened, "保存项目");
      await expect(reopened.getByRole("status", { name: "已保存", exact: true })).toBeVisible();

      nextTool = { name: "canvas_get_state", args: { nodeIds: [laterId] } };
      afterRead = {
        name: "generate_media",
        args: { items: [{ nodeId: laterId }] },
      };
      await reopened.getByRole("textbox", { name: "画布消息" }).fill("提出一项生成任务。");
      await reopened.getByRole("button", { name: "发送", exact: true }).click();
      await expect(reopened.getByRole("heading", { name: "申请生成 1 个节点" })).toBeVisible();
      await projectAction(reopened, "关闭项目");
      await expect(reopened).toHaveTitle("灵可 · Link Studio");
      const filingChannel = await reopened.evaluate(async () => {
        const saved = await window.desktop.settings.channelSave({
          expectedRevision: 0,
          approve: true,
          fields: {
            name: "历史备案夹具",
            endpoint: "https://ark.cn-beijing.volces.com",
            enabled: true,
            allowLocal: false,
            sort: 1,
            headers: [],
            filing: { enabled: true, groupId: "fixture", projectName: "" },
          },
          filingKeys: { accessKey: "fixture-access", secretKey: "fixture-secret" },
        });
        if (!saved.ok) throw Error(saved.code);
        return { channelId: saved.value.id, channelRevision: saved.value.revision };
      });
      await reopened.getByRole("button", { name: "应用设置" }).click();
      await reopened.getByRole("button", { name: "虚拟人像库" }).click();
      const people = reopened.getByRole("dialog", { name: "虚拟人像库" });
      await people.getByLabel("真人名称").fill("历史角色");
      await people.getByRole("button", { name: "从个人库选择图片" }).click();
      const historical = reopened.getByRole("dialog", { name: "选择图片" });
      await historical.getByRole("tab", { name: "生成历史" }).click();
      await historical.getByRole("searchbox").fill("古偶唯美柔光");
      const generatedCards = historical.locator(".asset-pick-card");
      await expect(generatedCards).toHaveCount(2);
      const registered = generatedCards.filter({ hasText: "已在资产库" });
      await expect(registered).toHaveCount(1);
      await expect(registered.locator("img")).toHaveJSProperty("naturalWidth", 2);
      await registered.getByRole("button").click();
      await historical.getByRole("tab", { name: "个人资产库" }).click();
      await expect(historical.locator('.asset-pick-card button[aria-pressed="true"]')).toHaveCount(
        1,
      );
      await historical.getByRole("tab", { name: "生成历史" }).click();
      await expect(registered.getByRole("button")).toHaveAttribute("aria-pressed", "true");
      await historical.getByRole("button", { name: "筛选", exact: true }).click();
      await historical.getByRole("button", { name: "首页对话" }).click();
      await expect(historical.getByText("没有符合条件的素材")).toBeVisible();
      await expect(historical.getByRole("button", { name: "添加并提交备案" })).toBeEnabled();
      await historical.getByRole("button", { name: "清除筛选" }).click();
      await expect(registered.getByRole("button")).toHaveAttribute("aria-pressed", "true");
      await historical.getByRole("button", { name: "关闭", exact: true }).click();
      await people.getByRole("button", { name: "关闭弹窗" }).click();
      await reopened
        .getByRole("navigation", { name: "设置分类" })
        .getByRole("button", { name: /^返回/ })
        .click();
      await reopened.getByRole("button", { name: /^生成闭环验收/ }).click();
      await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
      const assistant = reopened.getByRole("region", { name: "画布小灵" });
      await expect(assistant.getByRole("status").filter({ hasText: /^就绪$/ })).toBeVisible();
      await expect(reopened.getByRole("heading", { name: "申请生成 1 个节点" })).toHaveCount(0);
      expect(asyncSubmits).toBe(1);

      nextTool = {
        name: "plan_update",
        args: { steps: [{ title: "检查生成素材", status: "done" }] },
      };
      await reopened.getByRole("textbox", { name: "画布消息" }).fill("把检查步骤放进计划。");
      await reopened.getByRole("button", { name: "发送", exact: true }).click();
      await expect(assistant.getByText("计划已完成（1 步）", { exact: true })).toBeVisible();
      await expect(reopened.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      const ask = {
        name: "ask_user",
        args: {
          questions: [
            { id: "ratio", label: "成片用什么画幅？", options: ["横屏", "竖屏"] },
            { id: "scene", label: "画面发生在哪里？" },
            {
              id: "style",
              kind: "choice",
              label: "选择风格",
              options: ["电影感", "冷色调", "黑白"],
              multi: true,
            },
            { id: "duration", kind: "number", label: "镜头时长" },
            { id: "source", kind: "url", label: "参考链接", required: false },
          ],
        },
      };
      const send = assistant.getByRole("button", { name: "发送", exact: true });
      nextTool = ask;
      await assistant.getByLabel("画布消息").fill("先确认关键创作条件。");
      await send.click();
      const question = assistant.getByRole("form", { name: "小灵提问" });
      await expect(question).toBeVisible();
      await expect(reopened).toHaveTitle("⏸ 待批准 · 生成闭环验收 - 灵可 · Link Studio");
      await expect(question.getByRole("button", { name: "提交回答" })).toBeDisabled();
      await expectAssistantContrast(question.getByRole("radio", { name: "横屏" }));
      await reopened.getByRole("button", { name: "关闭小灵", exact: true }).click();
      await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
      await expect(question).toBeVisible();
      await question.getByRole("radio", { name: "横屏" }).check();
      await question.getByRole("textbox", { name: "画面发生在哪里？" }).fill("雨夜街道");
      await question.getByRole("checkbox", { name: "电影感" }).check();
      await question.getByRole("checkbox", { name: "冷色调" }).check();
      await question.getByRole("textbox", { name: "镜头时长" }).fill("1e999");
      await expect(question.getByText("请输入有效数字。")).toBeVisible();
      await question.getByRole("textbox", { name: "镜头时长" }).fill("2.5");
      await question.getByRole("textbox", { name: "参考链接" }).fill("file:///tmp/fixture");
      await expect(question.getByRole("button", { name: "提交回答" })).toBeDisabled();
      await question.getByRole("textbox", { name: "参考链接" }).clear();
      await question.getByRole("button", { name: "提交回答" }).click();
      await expect(
        assistant
          .getByRole("region", { name: "小灵提问记录" })
          .getByLabel("你的回答：雨夜街道")
          .getByText("画面发生在哪里？"),
      ).toBeVisible();
      await expect.poll(() => sawQuestionAnswers).toBe(true);
      await expect(send).toBeVisible();
      nextTool = ask;
      await assistant.getByLabel("画布消息").fill("允许跳过这个问题。");
      await send.click();
      await expect(question).toBeVisible();
      await assistant.getByLabel("画布消息").fill("改为保留原画幅。");
      await assistant.getByRole("button", { name: "插话", exact: true }).click();
      await expect(assistant.getByText("跳过了 5 个问题", { exact: true })).toBeVisible();
      await expect.poll(() => sawQuestionSkip).toBe(true);
      await expect(
        assistant.getByRole("log").getByText("改为保留原画幅。", { exact: true }),
      ).toBeVisible();
      await expect(send).toBeVisible();
      nextTool = {
        name: "ask_user",
        args: {
          questions: [
            { id: "image-model", label: "使用哪个图片模型？", kind: "model", modelKind: "image" },
          ],
        },
      };
      await assistant.getByLabel("画布消息").fill("先选择图片模型。");
      await send.click();
      const modelQuestion = assistant
        .getByRole("group", { name: "使用哪个图片模型？" })
        .getByRole("listbox");
      await expect(modelQuestion).toBeVisible();
      const imageOption = modelQuestion.getByRole("option", { name: /gpt-image-1.*回环图片/ });
      await expectAssistantContrast(imageOption);
      selectedQuestionModel = (await imageOption.getAttribute("value")) ?? "";
      expect(selectedQuestionModel).toBeTruthy();
      await expect(modelQuestion).not.toContainText("回环小灵");
      await imageOption.click();
      await expect(
        assistant
          .getByLabel(`你的回答：gpt-image-1（模型 key：${selectedQuestionModel}）`, {
            exact: true,
          })
          .getByText("使用哪个图片模型？"),
      ).toBeVisible();
      await expect.poll(() => sawQuestionModel).toBe(true);
      await expect(send).toBeVisible();
      expect(imageCalls).toBe(1);
      expect(asyncSubmits).toBe(1);
      const referenceSummary = assistant.getByRole("button", { name: "添加附件" });
      await expectAssistantContrast(referenceSummary);
      await referenceSummary.click();
      const attachments = reopened.getByRole("dialog", { name: "添加附件" });
      await expect(attachments).toBeVisible();
      await expect
        .poll(async () => {
          const trigger = await referenceSummary.boundingBox();
          const popup = await attachments.boundingBox();
          return (
            !!trigger &&
            !!popup &&
            Math.abs(popup.x - trigger.x) < 1 &&
            Math.abs(trigger.y - popup.y - popup.height - 8) < 1
          );
        })
        .toBe(true);
      await attachments.getByText("更多资料", { exact: true }).click();
      const webGrant = attachments.getByRole("checkbox", { name: "允许本轮联网检索" });
      await expect(webGrant).not.toBeChecked();
      const reference = attachments.getByLabel("公开文本链接");
      await expectAssistantContrast(reference, "::placeholder");
      await reference.fill(`${endpoint}/reference.txt`);
      const privatePrompt = "请检查这个画布节点，诊断不应包含这句话。";
      await assistant.getByLabel("画布消息").fill(privatePrompt);
      await assistant.getByRole("button", { name: "发送", exact: true }).click();
      await expect(assistant.getByRole("alert")).toContainText("无法读取资料");
      await expectAssistantContrast(assistant.getByRole("alert"));
      expect(referenceRequests).toBe(0);
      await assistant.getByRole("button", { name: "移除链接" }).click();
      const output = join(root, "diagnostics.json");
      await application.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: path,
        })) as typeof dialog.showSaveDialog;
      }, output);
      await assistant.getByRole("button", { name: "导出运行诊断" }).click();
      await expect(
        assistant.getByRole("status").filter({ hasText: "已导出运行诊断。" }),
      ).toBeVisible();
      const diagnostic = await readFile(output, "utf8");
      expect(diagnostic).not.toContain(privatePrompt);
      expect(diagnostic).not.toContain("fixture-secret");
      expect(diagnostic).not.toContain(endpoint);
      expect(JSON.parse(diagnostic)).toMatchObject({
        schemaVersion: 1,
        events: expect.arrayContaining([
          expect.objectContaining({ type: "model.call", purpose: "main", httpStatus: 200 }),
          expect.objectContaining({ type: "model.usage" }),
          expect.objectContaining({ type: "tool.end" }),
        ]),
      });
      await expect(attachments).toBeHidden();
      await referenceSummary.click();
      await attachments.getByText("更多资料", { exact: true }).click();
      await webGrant.check();
      await expect(assistant.getByText("本轮联网检索", { exact: true })).toBeVisible();
      await assistant.getByLabel("画布消息").fill("本轮允许查阅公开创作资料。");
      await send.click();
      await expect
        .poll(() => allowedTools)
        .toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
      await expect(assistant.getByText("本轮联网检索", { exact: true })).toHaveCount(0);
      await expect(send).toBeVisible();
      await assistant
        .getByLabel("画布消息")
        .fill(
          `下一轮仅使用画布内容。查看@[当前节点](node:${nodeId})，保留@[普通文本](other:abc)。`,
        );
      await send.click();
      await expect.poll(() => allowedTools).not.toContain("web_search");
      const historyBubble = assistant
        .getByRole("article", { name: "你的消息" })
        .filter({ hasText: "下一轮仅使用画布内容。" });
      await expect(historyBubble.getByTitle(`node:${nodeId}`, { exact: true })).toHaveText(
        "当前节点",
      );
      await expect(historyBubble).toContainText("@[普通文本](other:abc)");
      expect(allowedTools).not.toContain("web_fetch");
      await expect(send).toBeVisible();
      nextTool = { name: "canvas_get_state", args: { nodeIds: [nodeId] } };
      afterRead = {
        name: "canvas_delete",
        args: {
          expectedCanvasRevision: await readRevision(),
          operations: [
            {
              type: "putNode",
              node: {
                id: "fixture-s4-opening",
                type: "creative",
                position: { x: 100, y: 130 },
                data: { kind: "script", label: "从一个想法开始", text: "助手修改的开场" },
              },
            },
            {
              type: "putNode",
              node: {
                id: "fixture-s4-group",
                type: "group",
                position: { x: 90, y: 380 },
                data: { label: "小灵分镜组" },
                width: 310,
                height: 200,
              },
            },
            {
              type: "putNode",
              node: {
                id: "fixture-s4-script",
                type: "creative",
                parentId: "fixture-s4-group",
                position: { x: 24, y: 40 },
                data: {
                  kind: "script",
                  label: "分镜草稿",
                  text: "",
                  storyboard: [
                    {
                      id: "shot-1",
                      scene: "夜班列车缓缓进站",
                      shot: "全景",
                      camera: "跟",
                      action: "值班员走到站台边",
                      dialogue: "请注意脚下。",
                      duration: 4,
                    },
                  ],
                },
              },
            },
          ],
        },
      };
      await assistant.getByLabel("画布消息").fill("把分镜草稿整理成组。");
      await assistant.getByRole("button", { name: "发送", exact: true }).click();
      await expect(assistant.getByRole("heading", { name: "画布变更审批" })).toBeVisible();
      await expect(reopened.locator('[data-id="fixture-s4-script"]')).toHaveCount(0);
      await assistant.getByText("预览 1 个镜头", { exact: true }).click();
      await expect(assistant.getByText("夜班列车缓缓进站", { exact: true })).toBeVisible();
      await expect(assistant.getByText("全景 · 跟 · 4 秒", { exact: true })).toBeVisible();
      const operation = assistant.getByText("查看操作", { exact: true }).first();
      await operation.press("Enter");
      await expect(operation).toHaveCSS("outline-style", "solid");
      const operationDetails = assistant.locator("details[open] pre");
      await expect(operationDetails).toBeVisible();
      await expectAssistantContrast(operationDetails);
      await assistant.screenshot({ path: test.info().outputPath("canvas-approval-theme.png") });
      await operation.press("Enter");
      await assistant.getByRole("button", { name: "应用画布变更" }).click();
      await expect(reopened.locator('[data-id="fixture-s4-script"]')).toHaveCount(1);
      const latestChanges = async () => {
        await expect(assistant.locator(".assistant-status[data-idle=true]")).toBeAttached();
        const footer = assistant.locator(".agent-changes-footer").last();
        const trigger = footer.getByRole("button", { name: /画布改动/ });
        await expect(trigger).toBeVisible();
        if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
        return footer.getByRole("region", { name: "本轮画布改动" });
      };
      const firstChanges = await latestChanges();
      await firstChanges.getByRole("button", { name: "全部定位" }).click();
      await assistant.getByRole("button", { name: "定位 小灵分镜组" }).click();
      await expect(reopened.locator('[data-id="fixture-s4-group"] .canvas-group')).toHaveAttribute(
        "data-agent-mark",
        "touched",
      );
      await expect(reopened.locator(".react-flow__node.selected")).toHaveAttribute(
        "data-id",
        "fixture-s4-group",
      );
      await expect(reopened.getByRole("button", { name: "缩放", exact: true })).toMatchAriaSnapshot(
        '- button "缩放": /.*%/',
      );
      const groupInput = assistant.getByLabel("画布消息");
      const groupGhost = groupInput.locator(".agent-editor-ghost");
      await expect(groupGhost).toHaveText("小灵分镜组");
      await groupInput.click();
      await expectDraft(groupInput, "@小灵分镜组 ");
      await groupInput.press("Backspace");
      await groupInput.press("Backspace");
      await expectDraft(groupInput, "");
      await expect(groupGhost).toHaveCount(0);
      await clickBlankCanvas(reopened);
      await expect(reopened.locator(".react-flow__node.selected")).toHaveCount(0);
      await assistant.getByRole("button", { name: "定位 小灵分镜组" }).click();
      await expect(groupGhost).toHaveText("小灵分镜组");
      await groupInput.click();
      await expectDraft(groupInput, "@小灵分镜组 ");
      await groupInput.press("ControlOrMeta+z");
      await expectDraft(groupInput, "");
      await expect(groupGhost).toHaveCount(0);
      for (const query of ["@小灵分镜组", "@fixture-s4-script"]) {
        await assistant.getByLabel("画布消息").fill(query);
        await expect(assistant.locator(".assistant-inline-menu")).toHaveCount(0);
      }
      nextTool = {
        name: "canvas_get_state",
        args: { nodeIds: ["fixture-s4-group"] },
      };
      afterRead = undefined;
      await assistant.getByLabel("画布消息").fill("检查分组及视口。");
      await assistant.getByRole("button", { name: "发送", exact: true }).click();
      await expect.poll(() => sawGroupContext).toBe(true);
      expect(catalogAfterDeletion).toMatchObject({ omitted: 0, edgeCount: expect.any(Number) });
      expect(catalogAfterDeletion).not.toHaveProperty("selected");
      await expect(assistant.locator(".assistant-status[data-idle=true]")).toBeAttached();
      const readActivity = assistant.locator(".assistant-tool-group").last();
      const activityToggle = readActivity.locator(":scope > button");
      await expect(activityToggle).toHaveAttribute("aria-expanded", "false");
      await activityToggle.click();
      const readRow = readActivity.getByRole("button", { name: "读取画布 读取 1 个节点" });
      await expect(readRow).toBeEnabled();
      await activityToggle.press("Tab");
      await expect(readRow).toBeFocused();
      await expect(readRow.locator(".assistant-tool-locate")).toHaveCSS("opacity", "1");
      await readRow.press("Enter");
      await expect(reopened.locator(".react-flow__node.selected")).toHaveAttribute(
        "data-id",
        "fixture-s4-group",
      );
      await expect(reopened.locator('[data-id="fixture-s4-group"] .canvas-group')).toHaveAttribute(
        "data-agent-mark",
        "touched",
      );
      await readActivity.screenshot({ path: test.info().outputPath("tool-node-location.png") });
      await clickBlankCanvas(reopened);
      await assistant.getByRole("button", { name: "定位 小灵分镜组" }).click();
      await expect(groupGhost).toHaveText("小灵分镜组");
      await groupInput.click();
      await expectDraft(groupInput, "@小灵分镜组 ");
      await reopened.keyboard.insertText("记录这个分组。");
      await groupInput.press("Enter");
      await expect
        .poll(() => catalogAfterCommit)
        .toMatchObject({
          nodes: expect.arrayContaining([
            {
              id: "fixture-s4-group",
              type: "group",
              label: "小灵分镜组",
              members: 1,
              hasOutput: false,
            },
            expect.objectContaining({
              id: "fixture-s4-script",
              kind: "storyboard",
              group: "fixture-s4-group",
              prompt: "1 镜 · 夜班列车缓缓进站",
            }),
          ]),
        });
      expect(catalogAfterCommit).not.toHaveProperty("selected");
      await expect(assistant.locator(".assistant-status[data-idle=true]")).toBeAttached();
      const historicalTurn = assistant
        .getByRole("article", { name: "你的消息" })
        .filter({ hasText: "记录这个分组。" });
      const historicalGroup = historicalTurn.getByTitle("node:fixture-s4-group", { exact: true });
      await expect(historicalGroup).toHaveText("小灵分镜组");
      await expect(historicalTurn.locator(".assistant-selection")).toHaveCount(0);
      await expect(assistant.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      const welcome = reopened.getByRole("region", { name: "从一个想法开始内容", exact: true });
      await expect(welcome).toHaveText("助手修改的开场");
      await assistant
        .getByRole("button", { name: "定位 从一个想法开始", exact: true })
        .last()
        .click();
      await expect(reopened.locator(".react-flow__node.selected")).toHaveAttribute(
        "data-id",
        "fixture-s4-opening",
      );
      await expect
        .poll(() =>
          welcome.evaluate(async (element) => {
            const before = element.getBoundingClientRect();
            await new Promise((resolve) => setTimeout(resolve, 120));
            const after = element.getBoundingClientRect();
            return before.x === after.x && before.y === after.y && before.width === after.width;
          }),
        )
        .toBe(true);
      await editTextNode(welcome, "人工保留的开场");
      await firstChanges.getByRole("button", { name: "撤销本轮" }).click();
      await expect(
        assistant.getByRole("status").filter({ hasText: "已撤销 2 项，跳过 1 项。" }),
      ).toBeVisible();
      await expect(historicalGroup).toHaveText("小灵分镜组");
      await expect(welcome).toHaveText("人工保留的开场");
      await clickBlankCanvas(reopened);
      await expect(reopened.locator(".react-flow__node.selected")).toHaveCount(0);
      for (const [draft, hint] of [
        ["检查@[小灵分镜组](node:fixture-s4-group)", "画布上没有这个节点"],
        ["使用@[旧技能](skill:disabled@1)", "没有这个技能，或已被停用"],
      ] as const) {
        const count = await assistant.getByRole("article", { name: "你的消息" }).count();
        await groupInput.fill(draft);
        await send.click();
        await expect(assistant.getByRole("alert")).toContainText(hint);
        await expectDraft(groupInput, draft);
        await expect(assistant.getByRole("article", { name: "你的消息" })).toHaveCount(count);
      }
      nextTool = {
        name: "canvas_apply_ops",
        args: {
          ops: [
            {
              op: "create_node",
              kind: "script",
              label: "直接编辑样本",
              prompt: "独立开场",
              position: { x: 300, y: 300 },
            },
          ],
        },
      };
      await assistant.getByLabel("画布消息").fill("创建一个开场文本节点。");
      await send.click();
      const directNode = reopened.getByRole("region", { name: "直接编辑样本内容", exact: true });
      await expect(directNode).toHaveText("独立开场");
      await expect(
        reopened.locator(".react-flow__node").filter({ has: directNode }).locator("article"),
      ).toHaveAttribute("data-agent-mark", "touched");
      const draftEditor = assistant.getByLabel("画布消息");
      await draftEditor.fill("@直接编辑样本");
      await expect(assistant.getByRole("option", { name: "直接编辑样本" })).toBeVisible();
      await draftEditor.press("Enter");
      await expectDraft(draftEditor, "@直接编辑样本 ");
      await expect(draftEditor).toBeFocused();
      await draftEditor.press("Backspace");
      await draftEditor.press("Backspace");
      await expectDraft(draftEditor, "");
      await expect(assistant.getByRole("heading", { name: "画布变更审批" })).toHaveCount(0);
      const directFrame = reopened.locator(".react-flow__node").filter({ has: directNode });
      const creationFooter = assistant
        .locator(".agent-changes-footer")
        .nth((await assistant.locator(".agent-changes-footer").count()) - 1);
      await latestChanges();
      const directId = await directFrame.getAttribute("data-id");
      const positionBefore = await directFrame.evaluate((element) => element.style.transform);
      nextTool = {
        name: "canvas_arrange",
        args: { layout: "row", nodeIds: ["fixture-s4-opening", directId] },
      };
      await assistant.getByLabel("画布消息").fill("把开场和新建的文本节点排成一行。");
      await send.click();
      await expect
        .poll(() => directFrame.evaluate((element) => element.style.transform))
        .not.toBe(positionBefore);
      const arrangement = await latestChanges();
      const directResults = assistant.getByRole("button", { name: "定位 直接编辑样本" });
      await expect(directResults).toHaveCount(2);
      await directResults.last().click();
      await expect(directFrame.locator("article")).toHaveAttribute("data-agent-mark", "touched");
      await arrangement.getByRole("button", { name: "撤销本轮" }).click();
      await expect
        .poll(() => directFrame.evaluate((element) => element.style.transform))
        .toBe(positionBefore);
      const deleteTool = {
        name: "canvas_delete",
        args: { nodeIds: [directId, "fixture-s4-opening"], reason: "清理开场草稿" },
      };
      nextTool = deleteTool;
      await draftEditor.fill("清理开场草稿");
      await send.click();
      await expect(assistant.getByRole("checkbox", { name: "删除「直接编辑样本」" })).toBeChecked();
      await assistant.getByRole("heading", { name: "申请删除" }).hover();
      await expect(directFrame.locator("article")).toHaveAttribute("data-agent-mark", "danger");
      await expect(reopened.locator('[data-id="fixture-s4-opening"] article')).toHaveAttribute(
        "data-agent-mark",
        "danger",
      );
      await draftEditor.hover();
      await expect(directFrame.locator("article")).not.toHaveAttribute("data-agent-mark", "danger");
      await assistant.getByRole("button", { name: "保留", exact: true }).click();
      await expect(directFrame.locator("article")).not.toHaveAttribute("data-agent-mark", "danger");
      await expect(directNode).toHaveText("独立开场");
      await expect(send).toBeVisible();
      nextTool = deleteTool;
      await draftEditor.fill("重新申请清理草稿");
      await send.click();
      await assistant.getByRole("checkbox", { name: "删除「从一个想法开始」" }).uncheck();
      await assistant.getByRole("button", { name: "删除 1 项" }).click();
      await expect(directNode).toHaveCount(0);
      await expect(welcome).toHaveText("人工保留的开场");
      await (await latestChanges()).getByRole("button", { name: "撤销本轮" }).click();
      await expect(directNode).toHaveText("独立开场");
      await creationFooter.getByRole("button", { name: "撤销本轮" }).click();
      await expect(directNode).toHaveCount(0);
      await chooseCanvasZoom(reopened, "适应画布");
      const opening = reopened
        .locator('[data-id="fixture-s4-opening"]')
        .getByText("从一个想法开始", { exact: true });
      await expect(opening).toBeInViewport();
      await opening.click();
      await assistant.getByRole("button", { name: "从引用剧本拆分镜" }).click();
      await expectDraft(assistant.getByLabel("画布消息"), /请读取我引用的剧本/);
      nextTool = { name: "canvas_get_state", args: { nodeIds: ["fixture-s4-opening"] } };
      afterRead = {
        name: "canvas_apply_ops",
        args: {
          ops: [
            {
              op: "create_node",
              kind: "storyboard",
              tempId: "board",
              label: "夜班分镜",
              storyboard: { shots: [{ scene: "列车进站" }, { scene: "门缓缓打开", duration: 5 }] },
            },
            { op: "connect", source: "fixture-s4-opening", target: "board" },
          ],
        },
      };
      await send.click();
      const board = reopened.locator(".react-flow__node").filter({ hasText: "夜班分镜" });
      await expect(board.getByTitle("共 8 秒")).toHaveText("2 镜 · 00:08");
      await expect(welcome).toHaveText("人工保留的开场");
      const boardChanges = await latestChanges();
      await expect(boardChanges.getByRole("button", { name: "定位 夜班分镜" })).toBeEnabled();
      await boardChanges.getByRole("button", { name: "撤销本轮" }).click();
      await expect(board).toHaveCount(0);
      afterRead = undefined;
      await projectAction(reopened, "项目文件");
      await reopened.getByRole("button", { name: "导入素材", exact: true }).click();
      await reopened.getByRole("button", { name: "将测试镜头.mp4加入画布" }).click();
      await reopened.getByRole("button", { name: "关闭项目文件" }).click();
      const clip = reopened
        .locator(".react-flow__node")
        .filter({ has: reopened.getByText("测试镜头", { exact: true }) });
      const clipId = await clip.getAttribute("data-id");
      if (!(await assistant.isVisible()))
        await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
      nextTool = {
        name: "canvas_capture_frame",
        args: { nodeId: clipId, frames: [{ at: "last" }] },
      };
      await draftEditor.fill("把这段视频的尾帧留在画布上。");
      await send.click();
      const tailFrame = reopened
        .locator(".react-flow__node")
        .filter({ hasText: "测试镜头 · 尾帧" });
      await expect(tailFrame).toHaveCount(1);
      const frameChanges = await latestChanges();
      await expect(
        frameChanges.getByRole("button", { name: "定位 测试镜头 · 尾帧" }),
      ).toBeEnabled();
      await frameChanges.getByRole("button", { name: "撤销本轮" }).click();
      await expect(tailFrame).toHaveCount(0);
      await expect(clip).toHaveCount(1);
      await assistant.getByLabel("画布消息").fill("切换面板后保留的草稿");
      await projectAction(reopened, "运行环境");
      await expect(assistant).toBeHidden();
      await reopened.getByRole("button", { name: "打开小灵", exact: true }).click();
      await expectDraft(assistant.getByLabel("画布消息"), "切换面板后保留的草稿");

      const profile = await reopened.evaluate(async () => {
        const result = await window.desktop.settings.list({});
        if (!result.ok) throw new Error(result.code);
        return result.value.providers.find(({ label }) => label === "回环小灵");
      });
      if (!profile) throw new Error("Missing settings model");
      await projectAction(reopened, "模型设置");
      await expect(reopened).toHaveTitle("灵可 · Link Studio");
      await reopened.getByRole("button", { name: "设置助手" }).click();
      nextTool = {
        name: "admin_propose_changes",
        args: {
          value: {
            providerId: profile.id,
            expectedRevision: profile.revision,
            changes: [
              { field: "label", value: "双入口验收模型" },
              { field: "model", value: "未选模型" },
            ],
          },
        },
      };
      await reopened
        .getByRole("textbox", { name: "消息", exact: true })
        .fill("检查已配置模型并调整名称。");
      await reopened.getByRole("button", { name: "发送", exact: true }).click();
      await expect(reopened.getByRole("heading", { name: "配置变更单" })).toBeVisible();
      expect(allowedTools).not.toContain("generate_media");
      expect(allowedTools).not.toContain("skill_read");
      await expect(reopened.getByRole("checkbox", { name: /双入口验收模型/ })).toBeChecked();
      await reopened.getByRole("checkbox", { name: /未选模型/ }).uncheck();
      await reopened.getByRole("option", { name: /应用 1 项变更/ }).click();
      const receipt = reopened.getByRole("group", { name: /变更单 .* 结果/ });
      await expect(receipt).toContainText("已应用 1 项");
      await expect(receipt.getByRole("list", { name: "未应用的条目" })).toHaveText("未应用：model");
      const current = await reopened.evaluate(async (id) => {
        const result = await window.desktop.settings.list({});
        if (!result.ok) throw new Error(result.code);
        return result.value.providers.find((entry) => entry.id === id);
      }, profile.id);
      expect(current?.model).toBe(profile.model);
      if (!current) throw new Error("Missing approved settings model");
      nextTool = {
        name: "admin_propose_changes",
        args: {
          value: {
            providerId: current.id,
            expectedRevision: current.revision,
            changes: [{ field: "label", value: "过期建议" }],
          },
        },
      };
      await reopened.getByRole("textbox", { name: "消息", exact: true }).fill("再提出名称变更。");
      await reopened.getByRole("button", { name: "发送", exact: true }).click();
      await expect(reopened.getByRole("heading", { name: "配置变更单" })).toBeVisible();
      await reopened.evaluate(
        async ({
          id,
          revision,
          pluginHash,
          endpoint,
          model,
          allowLocal,
          agentEnabled,
          agentVision,
          channel,
        }) => {
          const saved = await window.desktop.settings.save({
            id,
            expectedRevision: revision,
            pluginHash,
            approve: false,
            fields: {
              label: "人工保留的配置",
              endpoint,
              model,
              allowLocal,
              agentEnabled,
              agentVision,
              channel,
            },
          });
          if (!saved.ok) throw new Error(saved.code);
        },
        current,
      );
      await reopened.getByRole("checkbox", { name: /过期建议/ }).check();
      await reopened.getByRole("option", { name: /应用 1 项变更/ }).click();
      const failedChange = reopened.getByRole("log").getByTitle("配置已更新，请重新载入后再保存。");
      await expect(failedChange).toHaveText("已批准，但执行失败：配置变更单");
      await expect
        .poll(() =>
          reopened.evaluate(async (id) => {
            const result = await window.desktop.settings.list({});
            return result.ok && result.value.providers.find((entry) => entry.id === id)?.label;
          }, current.id),
        )
        .toBe("人工保留的配置");
      await reopened
        .getByRole("navigation", { name: "设置分类" })
        .getByRole("button", { name: /^返回/ })
        .click();
      await expect(
        assistant.getByRole("separator", { name: "生成全部结束 · Agent 自动继续" }),
      ).toHaveCount(1);
      await expect(assistant.getByText("检查已配置模型并调整名称。", { exact: true })).toHaveCount(
        0,
      );
      holdCompletion = true;
      await assistant.getByLabel("画布消息").fill("收起窗口后提醒我回复完成。");
      await assistant.getByRole("button", { name: "发送", exact: true }).click();
      await expect(assistant.getByRole("button", { name: "停止", exact: true })).toBeVisible();
      await assistant.getByRole("button", { name: "关闭小灵" }).click();
      finishCompletion();
      await reopened.getByRole("button", { name: "好啦，回复写完了" }).click();
      await expect(assistant.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      await projectAction(reopened, "关闭项目");
      const cache = new DatabaseSync(join(root, "projects", "generated-images.sqlite"));
      try {
        cache.exec(
          "CREATE TRIGGER reject_cleanup BEFORE DELETE ON canvases BEGIN SELECT RAISE(ABORT,'fixture'); END",
        );
        const grant = await reopened.evaluate(async (scope) => {
          const api = window.desktop.projects,
            history = await api.filingLibraryPage({ ...scope, history: {} });
          if (!history.ok || !history.value.items[0] || !history.value.canvases?.[0])
            throw Error("缺少已授权历史");
          const { page, session, items, canvases } = history.value;
          return { page, session, choice: items[0]!.choice, recentEntryId: canvases[0]!.id };
        }, filingChannel);
        const readPreview = () =>
          application!.evaluate(
            async ({ BrowserWindow }, url) =>
              (
                await BrowserWindow.getAllWindows()[0]!.webContents.session.fetch(url, {
                  cache: "no-store",
                })
              ).status,
            `link-media://filing-library/${grant.page}/${grant.choice}`,
          );
        expect(await readPreview()).toBe(200);
        expect(
          await reopened.evaluate(
            async (recentEntryId) =>
              (await window.desktop.projects.removeRecent({ recentEntryId })).ok,
            grant.recentEntryId,
          ),
        ).toBe(true);
        expect(await readPreview()).toBe(404);
        const remaining = await reopened.evaluate(
          async ({ scope, grant }) => {
            const api = window.desktop.projects,
              { page, choice, session } = grant;
            const remaining = await api.filingLibraryPage({
              ...scope,
              session,
              history: {},
              carry: { page, choice },
            });
            if (!remaining.ok) throw Error(remaining.error.message);
            await api.filingLibraryClose({ session });
            return { count: remaining.value.items.length, carried: !!remaining.value.selected };
          },
          { scope: filingChannel, grant },
        );
        expect(remaining).toEqual({ count: 0, carried: false });
        expect(
          cache.prepare("SELECT id FROM canvases WHERE id=?").get(grant.recentEntryId),
        ).toBeDefined();
        expect(JSON.parse(await readFile(join(root, "projects", "recent.json"), "utf8"))).toEqual(
          [],
        );
      } finally {
        cache.close();
      }
    } finally {
      finishCompletion();
      await application?.close();
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
