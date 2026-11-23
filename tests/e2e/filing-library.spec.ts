import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { addCanvasNode, projectAction } from "./workspace-actions";

test("素材库选本机原图，新建真人并上传，立即显示归属而不再提供重复入口", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-enroll-"));
  const image = join(directory, "林舟_正面.png");
  await copyFile(join(process.cwd(), "resources/icons/icon-32.png"), image);
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: directory,
    LINK_STUDIO_TEST_PROJECT_PARENT: directory,
    LINK_STUDIO_TEST_MEDIA_FILES: image,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    ...(process.env.LINK_STUDIO_E2E_EXECUTABLE
      ? { executablePath: process.env.LINK_STUDIO_E2E_EXECUTABLE }
      : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const id = await page.evaluate(async () => {
      const saved = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "方舟",
          endpoint: "https://ark.cn-beijing.volces.com",
          enabled: true,
          allowLocal: false,
          sort: 1,
          headers: [],
          filing: { enabled: true, groupId: "sample", projectName: "" },
        },
        filingKeys: { accessKey: "sample-access", secretKey: "sample-secret" },
      });
      if (!saved.ok) throw new Error(saved.code);
      return saved.value.id;
    });
    await app.evaluate(() => {
      const dns = process.getBuiltinModule("dns/promises");
      const https = process.getBuiltinModule("https");
      const { Readable, Writable } = process.getBuiltinModule("stream");
      const lookup = dns.lookup,
        request = https.request;
      const hosts = new Set(["objects.fixture.org", "ark.cn-beijing.volcengineapi.com"]);
      const sent: { host: string; method: string; size: number; url?: string }[] = [];
      Reflect.set(globalThis, "enrollRequests", sent);
      Object.assign(dns, {
        lookup: async (host: string, options: object) =>
          hosts.has(host) ? [{ address: "93.184.216.34", family: 4 }] : lookup(host, options),
      });
      Object.assign(https, {
        request: (
          target: URL,
          options: { method: string },
          callback: (response: unknown) => void,
        ) => {
          if (!hosts.has(target.hostname)) return request(target, options, callback as never);
          const data: Buffer[] = [];
          const stream = new Writable({
            write(chunk, _encoding, done) {
              data.push(Buffer.from(chunk));
              done();
            },
          });
          stream.on("finish", () => {
            const body = Buffer.concat(data);
            const create = target.searchParams.get("Action") === "CreateAsset";
            sent.push({
              host: target.hostname,
              method: options.method,
              size: body.length,
              url: create ? JSON.parse(body.toString()).URL : undefined,
            });
            callback(
              Object.assign(
                Readable.from([
                  Buffer.from(
                    JSON.stringify({
                      Result: create ? { Id: `remote-file-${sent.length}` } : { Status: "Active" },
                    }),
                  ),
                ]),
                { statusCode: 200, headers: {} },
              ),
            );
          });
          return stream;
        },
      });
      process.getBuiltinModule("module").syncBuiltinESMExports();
    });
    await page.getByRole("button", { name: "模型设置" }).click();
    await page.getByRole("button", { name: "虚拟人像库" }).click();
    await page.getByRole("button", { name: "配置图片对象存储" }).click();
    const storage = page.getByRole("dialog", { name: "图片对象存储" });
    await storage.getByLabel("存储服务商").selectOption("r2");
    await expect(storage.getByLabel("Account ID")).toBeVisible();
    await expect(storage.getByLabel("S3 端点")).toHaveCount(0);
    await storage.getByLabel("存储服务商").selectOption("aliyun_oss");
    await expect(storage.getByLabel("区域")).toHaveValue("cn-hangzhou");
    await expect(storage.getByLabel("寻址方式")).toHaveCount(0);
    await storage.getByLabel("存储服务商").selectOption("s3");
    await expect(storage.getByLabel("寻址方式")).toHaveValue("auto");
    await storage.getByLabel("S3 端点").fill("https://objects.fixture.org");
    await storage.getByLabel("桶名称").fill("fixtures");
    await storage.getByLabel("存储 Access Key").fill("objects-access");
    await storage.getByLabel("存储 Secret Key").fill("objects-secret");
    await storage.getByRole("button", { name: "保存" }).click();
    await expect(storage).toHaveCount(0);
    await page
      .getByRole("dialog", { name: "虚拟人像库" })
      .getByRole("button", { name: "关闭弹窗" })
      .click();
    await page.getByRole("button", { name: "返回工作区" }).click();
    await page.getByRole("button", { name: "新建项目" }).click();
    await projectAction(page, "素材库");
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    const enroll = page.getByRole("dialog", { name: "加入真人库", exact: true });
    await page.getByRole("button", { name: "加入真人库", exact: true }).click();
    await expect(enroll.getByLabel("真人名称")).toHaveValue("林舟");
    await expect(enroll.locator("img")).toHaveJSProperty("naturalWidth", 32);
    await enroll.getByRole("button", { name: "加入并提交备案" }).click();
    await expect(enroll).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "图片已加入真人库并提交审核" }),
    ).toBeVisible();
    await expect(page.getByText("真人 · 林舟", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "加入真人库", exact: true })).toHaveCount(0);
    await projectAction(page, "素材库");
    await projectAction(page, "素材库");
    await expect(page.getByText("真人 · 林舟", { exact: true })).toBeVisible();
    const sent = await app.evaluate(() => Reflect.get(globalThis, "enrollRequests"));
    expect(sent).toMatchObject([
      { host: "objects.fixture.org", method: "PUT" },
      { host: "ark.cn-beijing.volcengineapi.com", method: "POST" },
    ]);
    expect(new URL(sent[1].url).searchParams.get("X-Amz-Credential")).toContain("objects-access/");
    expect(
      await page.evaluate(
        (id) => window.desktop.settings.filingAssets({ id, expectedRevision: 1, action: "list" }),
        id,
      ),
    ).toMatchObject({
      ok: true,
      value: [{ name: "林舟_正面.png", humanName: "林舟", status: "processing" }],
    });
    await projectAction(page, "模型设置");
    await page.getByRole("button", { name: "虚拟人像库" }).click();
    await page.getByRole("button", { name: "查看详情" }).click();
    const detail = page.getByRole("dialog", { name: "林舟", exact: true });
    const picker = page.getByRole("dialog", { name: "选择图片", exact: true });
    await detail.getByRole("button", { name: "添加图片" }).click();
    await expect(picker.getByRole("button", { name: "林舟_正面.png" })).toHaveAccessibleDescription(
      "已在真人库",
    );
    await expect(picker.getByRole("button", { name: "林舟_正面.png" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "添加图片" })).toBeFocused();
    await detail.getByRole("button", { name: "添加图片" }).click();
    const side = join(directory, "林舟_侧面.png");
    await copyFile(join(process.cwd(), "resources/icons/icon-64.png"), side);
    await expect(picker.getByText("已在真人库")).toBeVisible();
    await picker.getByLabel("选择要上传的文件").setInputFiles(side);
    const submit = picker.getByRole("button", { name: "添加并提交备案" });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(picker).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "移除图片" })).toHaveCount(2);
    const result = await page.evaluate(
      (id) => window.desktop.settings.filingAssets({ id, expectedRevision: 1, action: "list" }),
      id,
    );
    expect(result.ok && result.value.map((row) => [row.name, row.humanName, row.cover])).toEqual([
      ["林舟_侧面.png", "林舟", false],
      ["林舟_正面.png", "林舟", true],
    ]);
    await detail.getByRole("button", { name: "添加图片" }).click();
    const spare = join(directory, "林舟_便装.png");
    await copyFile(join(process.cwd(), "resources/icons/icon-48.png"), spare);
    await picker.getByLabel("选择要上传的文件").setInputFiles(spare);
    await expect(submit).toBeEnabled();
    const separate = join(directory, "配角_角色.png");
    await copyFile(join(process.cwd(), "resources/icons/icon-128.png"), separate);
    await picker.getByLabel("选择要上传的文件").setInputFiles(separate);
    await expect(picker.getByRole("button", { name: "配角_角色.png", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await detail.getByRole("button", { name: "完成" }).click();
    await page
      .getByRole("dialog", { name: "虚拟人像库" })
      .getByRole("button", { name: "关闭弹窗" })
      .click();
    await page.getByRole("button", { name: "返回工作区" }).click();
    await projectAction(page, "关闭项目");
    const folderFixture = new DatabaseSync(join(directory, "personal-library", "items.sqlite"));
    try {
      const folderId = "791a61d7-1e02-47bc-a815-779daf4f0f66";
      folderFixture
        .prepare("INSERT INTO library_folders VALUES(?,?,?)")
        .run(folderId, "角色图", new Date().toISOString());
      expect(
        folderFixture
          .prepare(
            "INSERT INTO folder_members SELECT id,? FROM library_items WHERE json_extract(record,'$.displayName')=?",
          )
          .run(folderId, "配角_角色.png").changes,
      ).toBe(1);
      const collection = crypto.randomUUID();
      folderFixture
        .prepare("INSERT INTO library_folders VALUES(?,?,?)")
        .run(collection, "分镜", new Date().toISOString());
      const source = JSON.parse(
        String(folderFixture.prepare("SELECT record FROM library_items LIMIT 1").get()!.record),
      );
      for (let number = 1; number <= 43; number++) {
        const assetId = crypto.randomUUID();
        folderFixture
          .prepare("INSERT INTO library_items VALUES(?,?,?,?)")
          .run(
            assetId,
            collection,
            assetId,
            JSON.stringify({ ...source, assetId, displayName: `分镜_${number}.png` }),
          );
        folderFixture.prepare("INSERT INTO folder_members VALUES(?,?)").run(assetId, collection);
      }
    } finally {
      folderFixture.close();
    }
    await page.getByRole("button", { name: "模型设置" }).click();
    await page.getByRole("button", { name: "虚拟人像库" }).click();
    await page.getByRole("button", { name: "查看详情" }).click();
    await detail.getByRole("button", { name: "添加图片" }).click();
    await picker.getByRole("button", { name: "打开文件夹 分镜" }).click();
    const firstFrame = picker.getByRole("button", { name: "分镜_43.png", exact: true });
    await firstFrame.click();
    const frameUrl = await picker
      .getByRole("img", { name: "分镜_43.png", exact: true })
      .getAttribute("src");
    const frames = picker.getByRole("button", { name: /^分镜_\d+\.png$/ });
    await expect(frames).toHaveCount(40);
    const scroll = picker.locator(".asset-pick-body");
    const indexDb = new DatabaseSync(join(directory, "personal-library", "items.sqlite"));
    try {
      indexDb.exec("ALTER TABLE removed_library_items RENAME TO unavailable_items");
      await scroll.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect(picker.getByRole("alert")).toHaveText("加载失败");
      await expect(frames).toHaveCount(40);
      await expect(picker.getByRole("button", { name: "取消选择 分镜_43.png" })).toBeVisible();
    } finally {
      indexDb.exec("ALTER TABLE unavailable_items RENAME TO removed_library_items");
      indexDb.close();
    }
    await picker.getByRole("button", { name: "重试", exact: true }).click();
    await expect(frames).toHaveCount(43);
    await expect(firstFrame).toHaveAttribute("aria-pressed", "true");
    await expect(picker.getByRole("img", { name: "分镜_43.png", exact: true })).toHaveAttribute(
      "src",
      frameUrl!,
    );
    await picker.getByRole("button", { name: "分镜_1.png", exact: true }).click();
    await picker
      .getByRole("navigation", { name: "当前位置" })
      .getByRole("button", { name: "个人资产库" })
      .click();
    await expect(frames).toHaveCount(0);
    await expect(picker.getByRole("button", { name: "取消选择 分镜_1.png" })).toBeVisible();
    expect(
      await page.evaluate(
        async ({ url, channelId }) => {
          const [, page] = new URL(url!).pathname.split("/");
          return (
            await window.desktop.projects.filingLibraryMore({
              page: page!,
              before: 1,
              channelId,
              channelRevision: 1,
            })
          ).ok;
        },
        { url: frameUrl, channelId: id },
      ),
    ).toBe(false);
    await picker.getByRole("button", { name: "打开文件夹 分镜" }).click();
    await expect(frames).toHaveCount(40);
    await scroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(picker.getByRole("button", { name: "分镜_1.png", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await picker.getByRole("button", { name: "取消选择 分镜_1.png" }).click();
    await picker
      .getByRole("navigation", { name: "当前位置" })
      .getByRole("button", { name: "个人资产库" })
      .click();
    const personalChoice = picker.getByRole("button", { name: "林舟_便装.png", exact: true });
    await expect(picker.getByRole("button", { name: "林舟_侧面.png" })).toBeDisabled();
    const imagePreview = picker.getByRole("img", { name: "林舟_便装.png", exact: true });
    await expect(imagePreview).toHaveJSProperty("naturalWidth", 48);
    await personalChoice.click();
    const tray = picker.getByRole("button", { name: "取消选择 林舟_便装.png" });
    const beforeSearch = await imagePreview.getAttribute("src");
    const searchDb = new DatabaseSync(join(directory, "personal-library", "items.sqlite"));
    try {
      searchDb.exec("ALTER TABLE folder_members RENAME TO unavailable_members");
      await picker.getByRole("searchbox", { name: "搜索文件名" }).fill("便装");
      await expect(picker.getByRole("alert")).toContainText("加载失败");
      await expect(tray.locator("img")).toHaveAttribute("src", beforeSearch!);
      await expect(submit).toBeEnabled();
      await expect(picker.getByRole("button", { name: "上传", exact: true })).toBeEnabled();
    } finally {
      searchDb.exec("ALTER TABLE unavailable_members RENAME TO folder_members");
      searchDb.close();
    }
    await picker.getByRole("button", { name: "重试", exact: true }).click();
    await expect(personalChoice).toHaveAttribute("aria-pressed", "true");
    await expect(tray.locator("img")).not.toHaveAttribute("src", beforeSearch!);
    await expect(picker.getByRole("button", { name: "林舟_侧面.png" })).toHaveCount(0);
    await tray.click();
    await expect(submit).toBeDisabled();
    const url = await imagePreview.getAttribute("src");
    expect(url).toMatch(/^link-media:\/\/filing-library\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/);
    const wrongTarget = await page.evaluate(
      async ({ url, channelId }) => {
        const [, page, choice] = new URL(url!).pathname.split("/");
        const input = {
          page: page!,
          choice: choice!,
          channelId,
          channelRevision: 1,
          confirmed: true as const,
          name: "未授权",
        };
        return Promise.all([
          window.desktop.projects.filingLibraryEnroll({ ...input, channelId: crypto.randomUUID() }),
          window.desktop.projects.filingLibraryEnroll({ ...input, channelRevision: 2 }),
        ]);
      },
      { url, channelId: id },
    );
    expect(wrongTarget.map((entry) => entry.ok)).toEqual([false, false]);
    await page.keyboard.press("Escape");
    await expect(detail.getByRole("button", { name: "添加图片" })).toBeFocused();
    const refused = await page.evaluate(
      async ({ url, channelId }) => {
        const [, page, choice] = new URL(url!).pathname.split("/");
        return window.desktop.projects.filingLibraryEnroll({
          page: page!,
          choice: choice!,
          channelId,
          channelRevision: 1,
          confirmed: true,
          name: "未授权",
        });
      },
      { url, channelId: id },
    );
    expect(refused.ok).toBe(false);
    await detail.getByRole("button", { name: "添加图片" }).click();
    await personalChoice.click();
    const confirmDb = new DatabaseSync(join(directory, "personal-library", "items.sqlite"));
    try {
      confirmDb.exec("ALTER TABLE folder_members RENAME TO unavailable_members");
      await picker.getByRole("searchbox", { name: "搜索文件名" }).fill("无匹配");
      await expect(picker.getByRole("alert")).toContainText("加载失败");
      await submit.click();
      await expect(picker).toHaveCount(0);
    } finally {
      confirmDb.exec("ALTER TABLE unavailable_members RENAME TO folder_members");
      confirmDb.close();
    }
    await expect(picker).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "移除图片" })).toHaveCount(3);
    await detail.getByRole("button", { name: "完成" }).click();
    const library = page.getByRole("dialog", { name: "虚拟人像库" });
    await library.getByLabel("真人名称").fill("配角");
    await library.getByRole("button", { name: "从个人库选择图片" }).click();
    await expect(picker.getByRole("button", { name: "配角_角色.png", exact: true })).toHaveCount(0);
    await picker.getByRole("searchbox", { name: "搜索文件名" }).fill("配角");
    await picker.getByRole("button", { name: "配角_角色.png", exact: true }).click();
    const oldPreview = await picker
      .getByRole("img", { name: "配角_角色.png", exact: true })
      .getAttribute("src");
    await picker
      .getByRole("navigation", { name: "当前位置" })
      .getByRole("button", { name: "个人资产库" })
      .click();
    await expect(picker.getByRole("button", { name: "配角_角色.png", exact: true })).toHaveCount(0);
    await expect(picker.getByRole("button", { name: "取消选择 配角_角色.png" })).toBeVisible();
    expect(
      await page.evaluate(
        async ({ url, channelId }) => {
          const [, page, choice] = new URL(url!).pathname.split("/");
          return (
            await window.desktop.projects.filingLibraryEnroll({
              page: page!,
              choice: choice!,
              channelId,
              channelRevision: 1,
              confirmed: true,
              name: "失效选择",
            })
          ).ok;
        },
        { url: oldPreview, channelId: id },
      ),
    ).toBe(false);
    await picker.getByRole("button", { name: "打开文件夹 角色图" }).click();
    await expect(picker.getByRole("navigation", { name: "当前位置" })).toContainText("角色图");
    await expect(
      picker.getByRole("button", { name: "配角_角色.png", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await submit.click();
    await expect(picker).toHaveCount(0);
    await expect(library.getByRole("region", { name: "配角", exact: true })).toContainText("0/1");
    await library
      .getByRole("region", { name: "配角", exact: true })
      .getByRole("button", { name: "查看详情" })
      .click();
    const sideDetail = page.getByRole("dialog", { name: "配角", exact: true });
    const file = join(directory, "配角_近景.png"),
      other = join(directory, "配角_夜景.png");
    await copyFile(join(process.cwd(), "resources/icons/icon-16.png"), file);
    await copyFile(join(process.cwd(), "resources/icons/icon-256.png"), other);
    const cancelled = await page.evaluate(
      async ({ channelId, image }) => {
        const api = window.desktop.projects,
          scope = { channelId, channelRevision: 1 };
        const first = await api.filingLibraryPage(scope);
        if (!first.ok) throw Error(first.error.message);
        const { session, destination } = first.value,
          bytes = new Uint8Array(image),
          uploadId = crypto.randomUUID();
        const writing = api.filingLibraryUpload({
          ...scope,
          session,
          destination,
          uploadId,
          name: "中止.png",
          bytes,
        });
        const result = await api.filingLibraryCancelUpload({ session, uploadId });
        const cancelled = (await writing).ok;
        const transferred = api.filingLibraryUpload({
          ...scope,
          session,
          destination,
          name: "跨页.png",
          bytes,
        });
        const next = await api.filingLibraryPage({ ...scope, session, search: "分镜" });
        const uploaded = await transferred;
        if (!next.ok || !uploaded.ok) throw Error("跨页上传失败");
        const receive = { ...scope, receipt: uploaded.value.receipt };
        const stale = await api.filingLibraryUploaded({ ...receive, page: first.value.page });
        const fresh = await api.filingLibraryUploaded({ ...receive, page: next.value.page });
        const replay = await api.filingLibraryUploaded({ ...receive, page: next.value.page });
        await api.filingLibraryClose({ session });
        const closed = await api.filingLibraryUpload({
          ...scope,
          session,
          destination,
          name: "关闭.png",
          bytes,
        });
        return [
          result.ok && result.value.cancelled,
          cancelled,
          stale.ok,
          fresh.ok && fresh.value.item.name,
          replay.ok,
          closed.ok,
        ];
      },
      { channelId: id, image: [...(await readFile(other))] },
    );
    expect(cancelled).toEqual([true, false, false, "跨页.png", false, false]);
    await sideDetail.getByRole("button", { name: "添加图片" }).click();
    await picker.getByRole("button", { name: "打开文件夹 角色图" }).click();
    const failureDb = new DatabaseSync(join(directory, "personal-library", "items.sqlite"));
    try {
      failureDb.exec(
        "CREATE TRIGGER fail_one_picture BEFORE INSERT ON library_items WHEN json_extract(NEW.record,'$.displayName')='重试.png' BEGIN SELECT RAISE(ABORT,'fixture'); END",
      );
      const retryFile = join(directory, "重试.png");
      await copyFile(file, retryFile);
      await picker.getByLabel("选择要上传的文件").setInputFiles(retryFile);
      const failed = picker.getByRole("group", { name: "重试.png", exact: true });
      await expect(failed.getByRole("alert")).toBeVisible();
      const searchbox = picker.getByRole("searchbox", { name: "搜索文件名" });
      await searchbox.fill("便装");
      await expect(
        picker.getByRole("button", { name: "林舟_便装.png", exact: true }),
      ).toBeVisible();
      await expect(failed).toHaveCount(0);
      await searchbox.fill("");
      await expect(failed.getByRole("alert")).toBeVisible();
      await picker.getByLabel("选择要上传的文件").setInputFiles({
        name: "不支持.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("invalid"),
      });
      const invalid = picker.getByRole("group", { name: "不支持.txt" });
      await invalid.getByRole("button", { name: "移除" }).click();
      await expect(invalid).toHaveCount(0);
      failureDb.exec("DROP TRIGGER fail_one_picture");
      await failed.getByRole("button", { name: "重试" }).click();
      await picker.getByRole("button", { name: "取消选择 重试.png" }).click();
      expect(
        failureDb
          .prepare(
            "SELECT count(*) AS n FROM library_items WHERE json_extract(record,'$.displayName')='重试.png'",
          )
          .get()?.n,
      ).toBe(1);
      expect(
        failureDb
          .prepare(
            "SELECT count(*) AS n FROM library_items WHERE json_extract(record,'$.displayName')='中止.png'",
          )
          .get()?.n,
      ).toBe(0);
      await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        Reflect.set(window, "releaseFilingReads", () => {
          File.prototype.arrayBuffer = original;
          release();
        });
        File.prototype.arrayBuffer = async function () {
          await gate;
          return original.call(this);
        };
      });
      const imageBytes = await readFile(file);
      await picker.getByLabel("选择要上传的文件").setInputFiles(
        Array.from({ length: 4 }, (_, index) => ({
          name: `跨目录_${index + 1}.png`,
          mimeType: "image/png",
          buffer: imageBytes,
        })),
      );
      await expect(picker.getByText("等待上传", { exact: true })).toBeVisible();
      await picker
        .getByRole("navigation", { name: "当前位置" })
        .getByRole("button", { name: "个人资产库" })
        .click();
      await expect(picker.getByRole("button", { name: "打开文件夹 角色图" })).toBeVisible();
      await expect(picker.getByText("等待上传", { exact: true })).toHaveCount(0);
      await page.evaluate(() => Reflect.get(window, "releaseFilingReads")());
      await expect(picker.getByRole("button", { name: /^取消选择 跨目录_/ })).toBeVisible();
      await expect(picker.getByRole("status")).toContainText("已选满");
      await expect
        .poll(
          () =>
            failureDb
              .prepare(
                "SELECT count(*) AS n FROM library_items JOIN folder_members ON item=library_items.id JOIN library_folders f ON f.id=folder WHERE f.name='角色图' AND json_extract(record,'$.displayName') LIKE '跨目录_%'",
              )
              .get()?.n,
        )
        .toBe(4);
      await expect(picker.getByRole("button", { name: /^跨目录_/ })).toHaveCount(0);
      await picker.getByRole("button", { name: "打开文件夹 角色图" }).click();
      await expect(picker.getByRole("button", { name: /^跨目录_/, pressed: true })).toHaveCount(1);
      await picker.getByRole("button", { name: /^取消选择 跨目录_/ }).click();
    } finally {
      failureDb.close();
    }
    const chooser = page.waitForEvent("filechooser");
    await picker.getByRole("button", { name: "上传", exact: true }).click();
    await (await chooser).setFiles([file, other]);
    await expect(picker.getByRole("status")).toContainText(
      /已选满，「配角_(夜景|近景).png」已上传但没有勾选/,
    );
    const skipped = (await picker.getByRole("status").innerText()).includes("夜景")
      ? "夜景"
      : "近景";
    await expect(
      picker.getByRole("button", {
        name: `配角_${skipped === "夜景" ? "近景" : "夜景"}.png`,
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      picker.getByRole("button", { name: `配角_${skipped}.png`, exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    const beforeSubmit = (await app.evaluate(() => Reflect.get(globalThis, "enrollRequests"))) as {
      method: string;
    }[];
    expect(beforeSubmit.filter((entry) => entry.method === "PUT")).toHaveLength(4);
    await page.keyboard.press("Escape");
    await sideDetail.getByRole("button", { name: "添加图片" }).click();
    await picker.getByRole("button", { name: "打开文件夹 角色图" }).click();
    await expect(picker.getByRole("button", { name: "配角_夜景.png", exact: true })).toBeEnabled();
    await picker.getByRole("button", { name: "配角_近景.png", exact: true }).click();
    await submit.click();
    await expect(sideDetail.getByRole("button", { name: "移除图片" })).toHaveCount(2);
    await sideDetail.getByRole("button", { name: "完成" }).click();
    await page
      .getByRole("dialog", { name: "虚拟人像库" })
      .getByRole("button", { name: "关闭弹窗" })
      .click();
    await page.getByRole("button", { name: "返回工作区" }).click();
    await page.getByRole("textbox", { name: "新项目名称" }).fill("跨项目备案");
    await page.getByRole("button", { name: "新建项目" }).click();
    await projectAction(page, "模型设置");
    await page.getByRole("button", { name: "虚拟人像库" }).click();
    await page
      .getByRole("region", { name: "林舟", exact: true })
      .getByRole("button", { name: "查看详情" })
      .click();
    await detail.getByRole("button", { name: "添加图片" }).click();
    const previous = picker.getByRole("button", { name: "林舟_侧面.png" });
    await expect(previous).toHaveAccessibleDescription("已在真人库");
    await expect(previous).toBeDisabled();
    await expect(picker.getByRole("button", { name: "林舟_便装.png" })).toBeDisabled();
    await expect(picker.getByRole("button", { name: "添加并提交备案" })).toBeDisabled();
    const requests = (await app.evaluate(() => Reflect.get(globalThis, "enrollRequests"))) as {
      method: string;
      url?: string;
    }[];
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(5);
    expect(requests.filter((item) => item.url)).toHaveLength(5);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("角色从真人库引入可用图片，保存后跨重启保护封面和补充图", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-human-pick-"));
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: directory,
    LINK_STUDIO_TEST_PROJECT_PARENT: directory,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({
      ...(process.env.LINK_STUDIO_E2E_EXECUTABLE
        ? { executablePath: process.env.LINK_STUDIO_E2E_EXECUTABLE }
        : { args: ["."] }),
      env,
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const endpoint = "https://ark.cn-beijing.volces.com";
    const id = await page.evaluate(async (endpoint) => {
      const saved = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "方舟",
          endpoint,
          enabled: true,
          allowLocal: false,
          sort: 1,
          headers: [],
          filing: { enabled: true, groupId: "sample", projectName: "" },
        },
        filingKeys: { accessKey: "sample-access", secretKey: "sample-secret" },
      });
      if (!saved.ok) throw new Error(saved.code);
      return saved.value.id;
    }, endpoint);
    const scope = createHash("sha256")
      .update(JSON.stringify([id, endpoint, "sample", "default"]))
      .digest("hex");
    const ciphertext = await app.evaluate(({ safeStorage }) => {
      const modules = process.getBuiltinModule("module");
      const dns = process.getBuiltinModule("dns/promises");
      const https = process.getBuiltinModule("https");
      const { Readable, Writable } = process.getBuiltinModule("stream");
      const lookup = dns.lookup;
      const mocked = new Set(["images.fixture.org", "ark.cn-beijing.volcengineapi.com"]);
      Object.assign(dns, {
        lookup: async (host: string, options: object) =>
          mocked.has(host) ? [{ address: "93.184.216.34", family: 4 }] : lookup(host, options),
      });
      const request = https.request;
      Object.assign(https, {
        request: (target: URL, options: object, callback: (response: unknown) => void) => {
          if (!mocked.has(target.hostname)) return request(target, options, callback as never);
          const bytes =
            target.hostname === "images.fixture.org"
              ? Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=",
                  "base64",
                )
              : Buffer.from(JSON.stringify({ Result: { Status: "Active" } }));
          const stream = new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          });
          stream.on("finish", () =>
            callback(Object.assign(Readable.from([bytes]), { statusCode: 200, headers: {} })),
          );
          return stream;
        },
      });
      modules.syncBuiltinESMExports();
      return [...safeStorage.encryptString("https://images.fixture.org/image.png")];
    });
    const db = new DatabaseSync(join(directory, "settings", "settings.sqlite"));
    try {
      for (const [image, name, status] of [
        ["side", "侧面", "processing"],
        ["cover", "封面", "active"],
        ["failed", "失败照", "failed"],
      ] as const) {
        db.prepare("INSERT INTO ark_assets VALUES (?,?,?,?,?)").run(
          scope,
          image,
          name,
          image,
          status,
        );
        db.prepare("INSERT INTO ark_members VALUES (?,?,?,?)").run(
          scope,
          image,
          "human",
          "范例真人",
        );
        db.prepare("INSERT INTO ark_sources VALUES (?,?,?,?)").run(
          scope,
          image,
          Buffer.from(ciphertext),
          image,
        );
      }
      db.prepare("INSERT INTO ark_covers VALUES (?,?,?)").run(scope, "human", "cover");
    } finally {
      db.close();
    }
    await page.getByRole("textbox", { name: "新项目名称" }).fill("引入验收");
    await page.getByRole("button", { name: "新建项目" }).click();
    await addCanvasNode(page, "角色卡");
    await page.getByRole("button", { name: "编辑角色卡" }).click();
    const character = page.getByRole("dialog", { name: "角色卡详情", exact: true });
    await character.getByRole("button", { name: "从真人库引入" }).click();
    const picker = page.getByRole("dialog", { name: "从真人库引入" });
    await expect(picker.getByRole("button", { name: "引入", exact: true })).toBeDisabled();
    await expect(picker.getByRole("button", { name: "范例真人 1 张" })).toBeVisible();
    await picker.getByRole("button", { name: "范例真人 2 张" }).click();
    await picker.getByRole("button", { name: "引入", exact: true }).click();
    await expect(character.getByLabel("主图", { exact: true })).toHaveText("封面.png");
    const extraImage = character.getByRole("button", { name: "放大预览补充图 1" });
    await expect(extraImage.locator("img")).toHaveJSProperty("naturalWidth", 3);
    await extraImage.hover();
    await expect(character.getByRole("button", { name: "移除补充图" })).toHaveCSS("opacity", "1");
    await expect(page.locator(".character-cover img")).toHaveCount(1);
    await expect(page.locator(".character-media-row img")).toHaveCount(1);
    await character.getByLabel("角色名").fill("甲");
    await extraImage.click();
    const gallery = page.getByRole("dialog", { name: "媒体预览" });
    await expect(gallery.getByText("形象图 2 / 2")).toBeVisible();
    await expect(gallery.getByRole("img", { name: "甲 补充图 1", exact: true })).toHaveJSProperty(
      "naturalWidth",
      3,
    );
    await expect(gallery.getByRole("button", { name: "定位到节点" })).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(gallery.getByText("形象图 1 / 2")).toBeVisible();
    await expect(gallery.getByRole("button", { name: "上一个" })).toBeDisabled();
    await gallery.getByRole("button", { name: "甲 补充图 1", exact: true }).click();
    await expect(gallery.getByText("形象图 2 / 2")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(gallery).toHaveCount(0);
    await expect(extraImage).toBeFocused();
    await expect(character.getByLabel("角色名")).toHaveValue("甲");
    await character.getByRole("button", { name: "关闭角色卡" }).click();
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const result = await window.desktop.settings.filingAssets({
            id,
            expectedRevision: 1,
            action: "list",
          });
          return result.ok && result.value.filter((image) => image.refs.length).length;
        }, id),
      )
      .toBe(2);
    const editFiles = (update: (database: DatabaseSync) => void) => {
      const database = new DatabaseSync(join(directory, "settings", "settings.sqlite"));
      try {
        update(database);
      } finally {
        database.close();
      }
    };
    editFiles((database) => {
      for (const [image, name] of [
        ["extra1", "正面"],
        ["extra2", "背面"],
      ] as const) {
        database
          .prepare("INSERT INTO ark_assets VALUES (?,?,?,?,?)")
          .run(scope, image, name, image, "active");
        database
          .prepare("INSERT INTO ark_members VALUES (?,?,?,?)")
          .run(scope, image, "human", "范例真人");
        database
          .prepare("INSERT INTO ark_sources VALUES (?,?,?,?)")
          .run(scope, image, Buffer.from(ciphertext), image);
      }
    });
    await page.getByRole("button", { name: "添加补充图" }).click();
    const extras = page.getByRole("dialog", { name: "选择补充图" });
    await extras.getByRole("tab", { name: "真人库" }).click();
    const person = extras.getByRole("region", { name: "范例真人" });
    for (const [file, reason] of [
      ["封面.png", "已是主图"],
      ["侧面.png", "已添加"],
      ["失败照", "备案失败"],
    ]) {
      await expect(person.getByRole("button", { name: file!, exact: true })).toBeDisabled();
      await expect(person.getByText(reason!, { exact: true })).toBeVisible();
    }
    await extras.getByRole("textbox", { name: "搜索真人名称" }).fill("不存在");
    await expect(extras.getByText("没有找到“不存在”")).toBeVisible();
    await extras.getByRole("textbox", { name: "搜索真人名称" }).fill("");
    await person.getByRole("button", { name: "正面", exact: true }).click();
    await person.getByRole("button", { name: "背面", exact: true }).click();
    const setReview = (status: string) =>
      editFiles((database) => {
        database
          .prepare("UPDATE ark_assets SET status=? WHERE scope=? AND id=?")
          .run(status, scope, "extra2");
      });
    setReview("failed");
    await extras.getByRole("button", { name: "确定" }).click();
    await expect(extras.getByRole("alert")).toContainText("无法引入所选素材");
    await expect(extras.getByText("已选择 2 个素材")).toBeVisible();
    await expect(person.getByRole("button", { name: "正面.png", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator(".character-media-row img")).toHaveCount(1);
    setReview("active");
    await extras.getByRole("button", { name: "确定" }).click();
    await expect(extras).toHaveCount(0);
    await expect(page.locator(".character-media-row img")).toHaveCount(3);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: /^引入验收/ }).click();
    await page.getByRole("button", { name: "添加补充图" }).click();
    const restored = page.getByRole("dialog", { name: "选择补充图" });
    await restored.getByRole("tab", { name: "真人库" }).click();
    for (const name of ["封面.png", "侧面.png", "正面.png", "背面.png"])
      await expect(restored.getByRole("button", { name, exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await projectAction(page, "模型设置");
    await page.getByRole("button", { name: "虚拟人像库" }).click();
    await page.getByRole("button", { name: "查看详情" }).click();
    await page.getByRole("button", { name: "移除真人" }).click();
    const confirm = page.getByRole("alertdialog", { name: "移除真人「范例真人」？" });
    await expect(confirm.getByText("《引入验收》角色卡「甲」")).toHaveCount(1);
    await expect(confirm.getByRole("button", { name: "确认移除" })).toBeDisabled();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("已有真人满五张后禁选，仍可选择其他真人或切回新建", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-filing-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const endpoint = "https://ark.cn-beijing.volces.com";
    const id = await page.evaluate(async (endpoint) => {
      const result = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "方舟样例",
          endpoint,
          enabled: true,
          allowLocal: false,
          sort: 1,
          headers: [],
          filing: { enabled: true, groupId: "sample", projectName: "" },
        },
        filingKeys: { accessKey: "fixture-access", secretKey: "fixture-secret" },
      });
      if (!result.ok) throw new Error(result.code);
      return result.value.id;
    }, endpoint);
    const scope = createHash("sha256")
      .update(JSON.stringify([id, endpoint, "sample", "default"]))
      .digest("hex");
    const database = new DatabaseSync(join(directory, "settings", "settings.sqlite"));
    try {
      for (let index = 0; index < 6; index++) {
        const asset = `sample-${index}`;
        database
          .prepare("INSERT INTO ark_assets VALUES (?,?,?,?,?)")
          .run(scope, asset, asset, asset, index % 2 ? "failed" : "active");
        database
          .prepare("INSERT INTO ark_members VALUES (?,?,?,?)")
          .run(scope, asset, index < 5 ? "full" : "open", index < 5 ? "角色甲" : "角色乙");
      }
    } finally {
      database.close();
    }
    const listed = await page.evaluate(
      (id) => window.desktop.settings.filingAssets({ id, expectedRevision: 1, action: "list" }),
      id,
    );
    expect(listed).toMatchObject({
      ok: true,
      value: expect.arrayContaining([expect.objectContaining({ humanId: "full", cover: true })]),
    });
    await page.getByRole("button", { name: "模型设置" }).click();
    await page.getByRole("button", { name: "虚拟人像库" }).click();
    const dialog = page.getByRole("dialog", { name: "虚拟人像库" });
    await expect(dialog.getByRole("button", { name: "加到已有真人" })).toBeVisible({
      timeout: 3000,
    });
    await dialog.getByRole("button", { name: "加到已有真人" }).click();
    await expect(dialog.getByRole("button", { name: "角色甲 5/5" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "加入并提交备案" })).toBeDisabled();
    await dialog.getByRole("button", { name: "角色乙 1/5" }).click();
    await expect(dialog.getByRole("button", { name: "加入并提交备案" })).toBeEnabled();
    await dialog.getByRole("button", { name: "新建真人" }).click();
    await expect(dialog.getByLabel("真人名称")).toBeVisible();
    const firstGroup = dialog.getByRole("region", { name: "角色甲" });
    const filters = dialog.getByRole("group", { name: "按备案状态筛选" });
    await expect(firstGroup).toContainText("可用 3/5");
    await filters.getByRole("button", { name: "失败 1" }).click();
    await expect(firstGroup).toHaveCount(0);
    await expect(dialog.getByRole("region", { name: "角色乙" })).toContainText("可用 0/1");
    await dialog
      .getByRole("region", { name: "角色乙" })
      .getByRole("button", { name: "查看详情" })
      .click();
    const single = page.getByRole("dialog", { name: "角色乙", exact: true });
    await expect(single).toContainText("方舟审核未通过，请换一张清晰的正面照");
    await expect(single.getByRole("button", { name: "重新提交" })).toBeDisabled();
    await expect(
      single.getByRole("list", { name: "真人图片" }).getByText("封面", { exact: true }),
    ).toBeVisible();
    await single.getByRole("button", { name: "移除图片" }).click();
    const lastImage = page.getByRole("alertdialog", { name: "移除图片「sample-5」？" });
    await expect(lastImage).toContainText("这是「角色乙」唯一的图片，请改用「移除真人」。");
    await expect(lastImage.getByRole("button", { name: "确认移除" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(single.getByRole("button", { name: "移除图片" })).toBeFocused();
    await single.getByRole("button", { name: "移除真人" }).click();
    const removePerson = page.getByRole("alertdialog", { name: "移除真人「角色乙」？" });
    await expect(removePerson).toHaveAccessibleDescription(
      "方舟侧的素材会一起删除，不可恢复；个人资产库里的原图保留。",
    );
    await expect(removePerson.getByRole("button", { name: "取消" })).toBeFocused();
    await page.mouse.click(2, 2);
    await expect(removePerson).toBeVisible();
    await expect(removePerson.getByRole("button", { name: "确认移除" })).toBeEnabled();
    await removePerson.getByRole("button", { name: "取消" }).click();
    await expect(single).toBeVisible();
    await single.getByRole("button", { name: "完成" }).click();
    await filters.getByRole("button", { name: "备案中 0" }).click();
    await expect(dialog.getByText("暂无符合条件的真人")).toBeVisible();
    await filters.getByRole("button", { name: "可用 1" }).click();
    await firstGroup.getByRole("button", { name: "查看详情" }).click();
    const detail = page.getByRole("dialog", { name: "角色甲", exact: true });
    await detail
      .locator(".adapter-field")
      .filter({ hasText: "sample-3" })
      .getByRole("button", { name: "设为封面" })
      .click();
    await expect(detail.locator(".adapter-field").first()).toContainText("sample-3");
    const rename = detail.getByLabel("真人名称", { exact: true });
    await rename.fill(" ");
    await rename.press("Enter");
    await expect(rename).toHaveValue("角色甲");
    await expect(detail.getByRole("status")).toHaveText("请输入名称");
    await rename.fill("角色改名");
    await rename.press("Enter");
    await page
      .getByRole("dialog", { name: "角色改名", exact: true })
      .getByRole("button", { name: "完成" })
      .click();
    await expect(dialog.getByRole("region", { name: "角色改名" })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭弹窗" }).click();
    await page.getByRole("button", { name: "虚拟人像库" }).click();
    await dialog
      .getByRole("region", { name: "角色改名" })
      .getByRole("button", { name: "查看详情" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "角色改名", exact: true }).locator(".adapter-field").first(),
    ).toContainText("sample-3");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
