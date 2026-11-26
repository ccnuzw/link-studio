import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

async function assertReadable(locator) {
  const result = await locator.evaluate((element) => {
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const layers = [];
    for (let layer = element; layer; layer = layer.parentElement) {
      layers.unshift(getComputedStyle(layer).backgroundColor);
    }
    const paint = (color) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    };
    const luminance = () => {
      const values = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), (value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    paint("white");
    layers.forEach(paint);
    const background = luminance();
    paint(getComputedStyle(element).color);
    const foreground = luminance();
    return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
  });
  assert.ok(result >= 4.5, `${locator} 对比度 ${result.toFixed(2)}`);
  return result;
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--allow-file-access-from-files"],
});
const output = resolve("test-results/desktop-shell");
await mkdir(output, { recursive: true });
try {
  for (const width of [1024, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 1024 ? 700 : 920 },
      colorScheme: "dark",
    });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    await page.exposeFunction("setHostTheme", (value) =>
      page.emulateMedia({ colorScheme: value === "system" ? "dark" : value }),
    );
    await page.addInitScript((background) => {
      const ok = (value) => ({ ok: true, value });
      const fail = () => ({
        ok: false,
        code: "UNAVAILABLE",
        error: { code: "UNAVAILABLE", messageKey: "不可用" },
      });
      const service = (methods) =>
        new Proxy(methods, { get: (target, key) => target[key] ?? (async () => fail()) });
      const session = {
        name: localStorage.getItem("test-project") ?? "夜雨来信",
        projectKind: localStorage.getItem("project-kind"),
        hasDrama: localStorage.getItem("legacy-drama") === "1",
        projectId: "test-project",
        projectHandle: "test-handle",
        schemaVersion: 1,
        revision: 1,
      };
      const recent = {
        displayName: session.name,
        displayPath: `/项目/${"本地素材".repeat(80)}`,
        projectId: session.projectId,
        recentEntryId: "recent",
        lastOpenedAt: new Date().toISOString(),
      };
      const channel = {
        id: "local",
        name: "模型服务",
        headers: [],
        enabled: true,
        endpoint: "https://example.invalid",
        revision: 1,
        sort: 0,
      };
      const canvas = {
        nodes: [
          {
            id: "script",
            type: "creative",
            position: { x: 250, y: 230 },
            data: { kind: "script", label: "对白", text: "午夜车站", drama: { episodes: [1] } },
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
      const prefs = {
        theme: localStorage.getItem("test-theme") ?? "dark",
        background: "dots",
        wheelMode: "pan",
        showHints: true,
        defaultModels: {},
      };
      window.desktop = {
        settings: service({
          canvasView: async (patch) => {
            Object.assign(prefs, patch);
            localStorage.setItem("test-theme", prefs.theme);
            await window.setHostTheme(prefs.theme);
            return ok(prefs);
          },
          list: async () => ok({ providers: [], plugins: [] }),
          channelList: async () => ok([channel]),
          channelLoads: async () => ok([]),
        }),
        projects: service({
          listRecent: async () =>
            ok({
              projects: localStorage.getItem("test-project")
                ? [{ ...recent, projectKind: session.projectKind, hasDrama: session.hasDrama }]
                : [],
            }),
          openRecent: async () => ok({ disposition: "opened", session }),
          create: async ({ name, projectKind }) => {
            session.name = name;
            session.projectKind = projectKind;
            localStorage.setItem("project-kind", projectKind);
            localStorage.setItem("test-project", name);
            return ok(session);
          },
          getCanvas: async () => ok({ canvas, revision: 1, canvasRevision: 0 }),
          listAssets: async () => ok({ assets: [] }),
          listJobs: async () => ok({ jobs: [], revision: 1, canvasRevision: 0 }),
          drama: async () =>
            ok(
              (localStorage.getItem("drama-ready") && {
                revision: 1,
                title: session.name,
                ratio: "9:16",
                outline_md: "夜雨中的车站",
                characters_md: "",
                episodes: [
                  {
                    episode_no: 1,
                    title: "来信",
                    synopsis: "车站重逢",
                    script_md: "午夜车站",
                    locked: true,
                    storyboard_status: "ready",
                  },
                ],
              }) ||
                null,
            ),
          close: async () => ok({}),
        }),
        dialogs: service({
          selectProjectParent: async () =>
            ok({ cancelled: !window.testChooseDirectory, directoryToken: "test" }),
        }),
        canvasWindow: {
          onActivateProject: (fn) => {
            window.activateProject = fn;
            return () => {
              delete window.activateProject;
            };
          },
          onSaveBeforeClose: () => () => {},
          setPending: () => {},
          setNoticeCanvas: () => {},
        },
        projectEvents: { onAgentChanged: () => () => {}, onLibraryChanged: () => () => {} },
        skills: service({ list: async () => ok([]) }),
        app: service({}),
      };
      if (background) {
        const entries = ["夜雨来信", "春日序曲"].map((displayName, index) => ({
          ...recent,
          displayName,
          displayPath: `/短剧/${displayName}`,
          projectKind: "drama",
          recentEntryId: `entry-${index}`,
        }));
        const projects = window.desktop.projects;
        window.closes = [];
        window.activities = {};
        projects.listRecent = async () =>
          ok({
            projects: entries.map((entry) => ({
              ...entry,
              activity: window.activities[entry.recentEntryId],
            })),
          });
        projects.openRecent = async ({ recentEntryId }) =>
          ok({
            disposition: "opened",
            session: {
              ...session,
              name: entries.find((entry) => entry.recentEntryId === recentEntryId).displayName,
              projectKind: "drama",
              projectHandle: recentEntryId,
            },
          });
        projects.open = async ({ directoryToken }) =>
          projects.openRecent({ recentEntryId: directoryToken });
        projects.close = async (request) => {
          window.closes.push(request);
          return ok({ closed: true });
        };
        const titles = {};
        projects.drama = async ({ projectHandle, editField }) => {
          if (editField) {
            if (window.denySave) return fail();
            titles[projectHandle] = editField.value;
            window.savedTitle = editField.value;
          }
          return ok({
            revision: 1,
            title:
              titles[projectHandle] ??
              entries.find((entry) => entry.recentEntryId === projectHandle).displayName,
            ratio: "9:16",
            outline_md: "故事大纲",
            characters_md: "",
            episodes: [
              { episode_no: 1, title: "重逢", synopsis: "归来", script_md: "", locked: false },
            ],
          });
        };
        window.desktop.canvasWindow.onSaveBeforeClose = (fn) => {
          window.nativeSave = fn;
          return () => {};
        };
      }
    }, process.argv.includes("--drama-background"));
    const assertViewport = async (label) => {
      assert.deepEqual(
        await page.evaluate(() => {
          const root = document.documentElement;
          return [root.scrollWidth - root.clientWidth, root.scrollHeight - root.clientHeight];
        }),
        [0, 0],
        `${width} ${label}`,
      );
    };
    const button = (name) => page.getByRole("button", { name, exact: true });
    await page.goto(pathToFileURL(resolve("out/renderer/index.html")).href);
    if (process.argv.includes("--drama-background")) {
      const row = (name) =>
        page.locator(".home-record").filter({ has: page.getByText(name, { exact: true }) });
      const open = (name) => row(name).getByRole("button").first().click();
      const nav = page.getByRole("navigation", { name: "打开的短剧项目" });
      const title = page.getByRole("textbox", { name: "项目名" });
      await open("夜雨来信");
      await expect(title).toHaveValue("夜雨来信");
      if (width === 1440) await button("切换到浅色").click();
      await page.evaluate(() => {
        window.activities["entry-0"] = { label: "分集剧本中", progress: 35, count: 1 };
      });
      await button("返回首页").click();
      await expect(row("夜雨来信").getByRole("progressbar")).toHaveAttribute("value", "35");
      await expect(button("移除夜雨来信最近记录")).toBeDisabled();
      await open("春日序曲");
      await expect(nav.getByRole("button", { name: "春日序曲", exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await page.evaluate(() => {
        const projects = window.desktop.projects;
        const original = projects.openRecent;
        projects.openRecent = async () => ({ ok: true, value: { disposition: "focusedExisting" } });
        window.restoreOpenRecent = () => {
          projects.openRecent = original;
        };
      });
      await nav.getByRole("button", { name: /^夜雨来信/ }).click();
      await expect(title).toHaveValue("春日序曲");
      await page.evaluate(() => window.restoreOpenRecent());
      await page.evaluate(() => {
        window.activities["entry-1"] = { label: "资产拆解中", progress: 10, count: 1 };
      });
      await nav.getByRole("button", { name: /^夜雨来信/ }).click();
      await expect(title).toHaveValue("夜雨来信");
      await expect(nav.getByRole("button", { name: /^夜雨来信/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(nav.getByRole("button", { name: /^春日序曲/ })).not.toHaveAttribute(
        "aria-current",
        "page",
      );
      await assertViewport("双项目标签");
      await button("关闭春日序曲标签").click();
      await expect(nav).toHaveCount(0);
      await expect(title).toHaveValue("夜雨来信");
      await button("返回首页").click();
      await expect(row("春日序曲").getByRole("progressbar")).toHaveAttribute("value", "10");
      await page.screenshot({ path: `${output}/background-home-${width}.png` });
      await page.evaluate(() => {
        delete window.activities["entry-1"];
        window.activities["entry-0"].progress = 65;
      });
      await expect(row("夜雨来信").getByRole("progressbar")).toHaveAttribute("value", "65");
      await expect(button("移除春日序曲最近记录")).toBeEnabled();
      await open("春日序曲");
      await button("关闭春日序曲标签").click();
      await expect(row("夜雨来信")).toBeVisible();
      assert.deepEqual(
        await page.evaluate(() => window.closes),
        ["entry-0", "entry-1", "entry-0", "entry-1"].map((projectHandle) => ({
          projectHandle,
          keepWorking: true,
        })),
      );
      await page.evaluate(() => {
        window.desktop.projects.openRecent = async () => ({
          ok: true,
          value: { disposition: "focusedExisting" },
        });
      });
      await open("夜雨来信");
      await expect(row("夜雨来信")).toBeVisible();
      await expect(page.getByText("项目已在另一个窗口打开")).toHaveCount(0);
      await page.evaluate(() => window.restoreOpenRecent());
      await open("夜雨来信");
      await title.fill("夜雨新章");
      await page.evaluate(() => {
        window.denySave = true;
      });
      const activate = (id) =>
        page.evaluate(
          (id) =>
            window.activateProject({ projectHandle: id, directoryToken: id, recentEntryId: id }),
          id,
        );
      await activate("entry-0");
      await expect(title).toHaveValue("夜雨新章");
      await activate("entry-1");
      await expect(page.getByText("当前编辑尚未保存，请先处理保存提示")).toBeVisible();
      assert.equal(await page.evaluate(() => window.nativeSave()), false);
      await expect(title).toHaveValue("夜雨新章");
      await page.evaluate(() => {
        window.denySave = false;
      });
      await activate("entry-1");
      await expect(title).toHaveValue("春日序曲");
      await expect(nav.getByRole("button", { name: /^春日序曲/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
      assert.equal(await page.evaluate(() => window.savedTitle), "夜雨新章");
      assert.equal(await page.evaluate(() => window.nativeSave()), true);
      assert.deepEqual(errors, []);
      console.log(`通过 ${width}px 双短剧切换、关闭、后台进度回放`);
      await page.close();
      continue;
    }
    if (process.argv.includes("--v072")) {
      const { replayRelease } = await import("./verify-v072.mjs");
      await replayRelease(page, width);
      assert.deepEqual(errors, []);
      await page.close();
      continue;
    }
    if (process.argv.includes("--task-recovery") || process.argv.includes("--asset-resilience")) {
      const deferred = process.argv.includes("--asset-resilience");
      await page.evaluate(() => {
        localStorage.setItem("test-project", "夜雨来信");
        localStorage.setItem("project-kind", "drama");
      });
      await page.reload();
      await page.evaluate((deferred) => {
        const service = window.desktop.projects;
        const ok = (value) => ({ ok: true, value });
        const nodes = ["filled", "blank"].map((id, index) => ({
          id,
          type: "creative",
          position: { x: index * 300, y: 150 },
          data: {
            label: id,
            kind: "image",
            text: index ? "" : "已有提示词",
            drama: { name: id, type: "scene", episodes: [index + 1] },
          },
        }));
        service.getCanvas = async () =>
          ok({
            canvas: { nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
            revision: 1,
            canvasRevision: 1,
          });
        const jobs = [
          ["old", "breakdown", [1], ["filled"], [1]],
          ["partial", "breakdown", [2, 3], ["blank"], [2]],
          ["board", "storyboard", [1], [], []],
        ].map(([id, step, episodes, new_nodes, done_episodes]) => ({
          id,
          step,
          episodes,
          new_nodes,
          done_episodes,
          status: "failed",
          error_message: "AGENT_TEST_NETWORK_FAILED",
        }));
        const doc = {
          revision: 1,
          title: "夜雨来信",
          outline_md: "故事",
          characters_md: "",
          episodes: [1, 2, 3].map((no) => ({
            episode_no: no,
            title: `来信 ${no}`,
            script_md: "午夜车站",
            locked: no < 3,
            script_status: "ready",
            storyboard_status: no === 1 ? "failed" : "empty",
          })),
          segments: [
            {
              id: "old-segment",
              episode_no: 1,
              seq: 0,
              seconds: 5,
              prompt: "旧版镜头",
              revision: 1,
            },
          ],
          jobs,
        };
        if (deferred) {
          Object.assign(jobs[1], {
            status: "succeeded",
            deferred_nodes: ["blank"],
            done_episodes: [2, 3],
            prompt_error: "模型输出达到长度上限",
            error_message: undefined,
          });
          doc.episodes[2].locked = true;
        }
        window.repairCalls = 0;
        service.estimateDramaBreakdown = async () => ok(6);
        service.drama = async (args) => {
          if (args.repairPrompts) {
            window.repairCalls++;
            doc.revision++;
            jobs.push({
              id: "repaired",
              status: "succeeded",
              step: "asset_prompts",
              episodes: [2, 3],
              prompted_nodes: ["blank"],
            });
          }
          return ok(structuredClone(doc));
        };
      }, deferred);
      await page.getByRole("button", { name: /夜雨来信.*本地素材/ }).click();
      if (width === 1440) await button("切换到浅色").click();
      await page.locator(".dp-task-trigger").click();
      await expect(button("补写 1 个提示词")).toBeVisible();
      await expect(page.locator(".dp-task-row")).toHaveCount(2);
      await expect(page.getByText("重新生成未完成，原有 1 段分镜已保留。")).toBeVisible();
      if (deferred)
        await expect(page.getByText("已拆解 2 集，卡片可用 · 1 个资产待补词")).toBeVisible();
      await page.locator(".dp-task-menu").screenshot({
        path: `${output}/${deferred ? "asset-resilience" : "recovery"}-${width}.png`,
      });
      await button("补写 1 个提示词").click();
      await expect(button("确认补写 · 约 6 积分")).toBeVisible();
      assert.equal(await page.evaluate(() => window.repairCalls), 0);
      await button("确认补写 · 约 6 积分").click();
      if (deferred) await expect(page.locator(".dp-task-row")).toHaveCount(1);
      else await expect(button("继续拆解 1 集")).toBeVisible();
      assert.equal(await page.evaluate(() => window.repairCalls), 1);
      await button("使用已有分镜").click();
      await expect(page.getByRole("tab", { name: "片场", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByRole("button", { name: "重新生成分镜脚本" })).toBeVisible();
      if (deferred) {
        await expect(page.locator(".dp-task-trigger")).toHaveCount(0);
        assert.deepEqual(errors, []);
        console.log(`通过 ${width}px 已拆解待补词回放`);
        await page.close();
        continue;
      }
      await page.locator(".dp-task-trigger").click();
      await expect(page.locator(".dp-task-row")).toHaveCount(1);
      await button("继续拆解 1 集").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      assert.deepEqual(errors, []);
      console.log(`通过 ${width}px 任务恢复回放`);
      await page.close();
      continue;
    }
    if (process.argv.includes("--drama-canvas")) {
      await page.evaluate(() => {
        localStorage.setItem("test-project", "夜雨来信");
        localStorage.setItem("project-kind", "drama");
        localStorage.setItem("drama-ready", "1");
      });
      const openRecent = async () => {
        await page.reload();
        await page.getByRole("button", { name: /夜雨来信.*本地素材/ }).click();
      };
      await openRecent();
      const toolbar = page.getByRole("toolbar", { name: "画布编辑" });
      for (const stage of ["资产管理", "片场"]) {
        await page.getByRole("tab", { name: stage, exact: true }).click();
        await page
          .getByRole("group", { name: "视图" })
          .getByRole("button", { name: "画布" })
          .click();
        await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
        const bounds = await toolbar.boundingBox();
        const slot = await page.locator(".drama-canvas-slot").boundingBox();
        assert.ok(Math.abs(bounds.x + bounds.width / 2 - slot.x - slot.width / 2) < 2);
        assert.ok(Math.abs(slot.y + slot.height - bounds.y - bounds.height - 12) < 2);
        await expect(page.locator(".canvas-view-zone")).toHaveCount(0);
        await toolbar.getByRole("radio", { name: "抓手" }).click();
        await expect(toolbar.getByRole("radio", { name: "抓手" })).toBeChecked();
        await button("添加节点").click();
        const menu = page.getByRole("menu", { name: "添加节点" });
        await expect(menu).toBeVisible();
        const popup = await menu.boundingBox();
        assert.ok(popup.y + popup.height < bounds.y);
        await page.keyboard.press("Escape");
        await expect(page.locator(".canvas-add-menu")).toHaveCount(0);
        for (const [toggle, scheme] of [
          ["切换到浅色", "light"],
          ["切换到深色", "dark"],
        ]) {
          await button(toggle).click();
          await expect
            .poll(() => page.evaluate(() => localStorage.getItem("test-theme")))
            .toBe(scheme);
          await assertViewport(stage);
          const tabs = await page.locator(".drama-stage-tabs").boundingBox();
          const settings = await button("项目设置").boundingBox();
          assert.ok(tabs.x + tabs.width <= settings.x);
          await assertReadable(
            page.locator(".drama-work-tools .canvas-credit-trigger span:last-child"),
          );
          if (width === 1440)
            await page.screenshot({
              path: `${output}/${stage}-canvas-${scheme}.png`,
              animations: "disabled",
            });
        }
        if (stage === "资产管理") await button("命令面板").click();
        else await page.keyboard.press("Meta+k");
        await page.getByRole("combobox", { name: "搜索命令" }).fill("第1集");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("tab", { name: "片场", exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        );
      }
      await page.evaluate(() => localStorage.setItem("project-kind", "canvas"));
      await openRecent();
      await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
      await expect(page.locator(".canvas-view-zone")).toBeVisible();
      assert.deepEqual(errors, []);
      console.log(`通过 ${width}px 双主题资产、片场和独立画布回放`);
      await page.close();
      continue;
    }
    await expect(page.getByRole("heading", { name: "创作工作台" })).toBeVisible();
    await assertViewport("首页");
    await button("应用设置").click();
    await expect(button("配置 API Key")).toBeVisible();
    await button("通用与外观").click();
    for (const [name, scheme] of [
      ["浅色", "light"],
      ["深色", "dark"],
      ["跟随系统", "dark"],
      ["浅色", "light"],
    ]) {
      await page.getByRole("radio", { name, exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(scheme === "dark");
      await button("模型与渠道").click();
      await assertViewport("模型与渠道");
      const searchGap = await page
        .getByRole("searchbox", { name: "搜索渠道", exact: true })
        .evaluate((input) => {
          const style = getComputedStyle(input);
          const start =
            input.getBoundingClientRect().left +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.paddingLeft);
          return start - input.parentElement.querySelector("svg").getBoundingClientRect().right;
        });
      assert.ok(searchGap >= 4, `搜索渠道图标与文字间距 ${searchGap}px`);
      const luminance = (locator) =>
        locator.evaluate((element) => {
          const ctx = document.createElement("canvas").getContext("2d");
          ctx.fillStyle = getComputedStyle(element).backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
          return ctx.getImageData(0, 0, 1, 1).data[0];
        });
      assert.equal((await luminance(page.locator(".channel-sidebar"))) > 150, scheme === "light");
      await button("编辑渠道").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      assert.equal((await luminance(page.getByRole("dialog"))) > 150, scheme === "light");
      await page.keyboard.press("Escape");
      await button("设置小灵").click();
      await assertViewport("设置小灵");
      await page.keyboard.press("Escape");
      await expect(button("设置小灵")).toBeFocused();
      if (width === 1440) await page.screenshot({ path: `${output}/settings-${scheme}.png` });
      const nav = page.getByRole("navigation", { name: "设置分类" });
      await nav.getByRole("button", { name: "技能管理" }).click();
      const skills = page.getByRole("region", { name: "技能管理" });
      await expect(skills).toBeVisible();
      const skillBox = await skills.boundingBox(),
        navBox = await nav.boundingBox();
      assert.ok(
        skillBox && navBox && skillBox.y >= navBox.y + navBox.height,
        `技能区域应位于设置顶栏下方（${width}px / ${scheme}）：${JSON.stringify({ skillBox, navBox })}`,
      );
      await expect(button("技能管理")).toHaveAttribute("aria-current", "page");
      await assertReadable(button("技能管理"));
      const switchTheme = scheme === "dark" ? "切换到浅色" : "切换到深色";
      const restoreTheme = scheme === "dark" ? "切换到深色" : "切换到浅色";
      await button(switchTheme).click();
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(scheme === "light");
      await button(restoreTheme).click();
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(scheme === "dark");
      await page.keyboard.press("/");
      await expect(skills.getByRole("searchbox")).toBeFocused();
      await assertViewport("技能管理");
      if (width === 1440) await page.screenshot({ path: `${output}/skills-${scheme}.png` });
      await button("导入技能").click();
      await expect(page.getByRole("dialog", { name: "导入技能" })).toBeVisible();
      await page.keyboard.press("Escape");
      await button("适配器管理").click();
      await button("插件草稿").click();
      await expect(page.getByRole("dialog", { name: "插件草稿" })).toBeVisible();
      await page.keyboard.press("Escape");
      await button("上传插件").hover();
      await assertReadable(button("上传插件"));
      await button("上传插件").click();
      const upload = page.getByRole("dialog", { name: "上传插件" });
      const summary = upload.getByText("预览提示词", { exact: true });
      await summary.hover();
      await assertReadable(summary);
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(upload.locator("pre")).toBeVisible();
      const contrast = await assertReadable(upload.locator("pre"));
      await assertReadable(upload.getByRole("heading"));
      await assertReadable(upload.getByText("用 AI 生成插件", { exact: true }));
      if (width === 1440) await page.screenshot({ path: `${output}/plugin-preview-${scheme}.png` });
      await upload.locator('input[type="file"]').setInputFiles({
        name: "invalid.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("fixture"),
      });
      await expect(upload.getByRole("alert")).toBeVisible();
      await assertReadable(upload.getByRole("alert").getByText("插件必须是 .js 文件"));
      console.log(`${width}px ${scheme} 预览提示词正文对比度 ${contrast.toFixed(2)}:1`);
      await page.keyboard.press("Escape");
      await expect(button("上传插件")).toBeFocused();
      await button("通用与外观").click();
    }
    await button("返回首页").click();
    await page.reload();
    await expect(button("应用设置")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches))
      .toBe(true);
    if (width === 1440) await page.screenshot({ path: `${output}/home-light.png` });
    await page.getByRole("button", { name: /新建画布项目/ }).click();
    await button("选择保存位置…").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    assert.equal(await page.evaluate(() => localStorage.getItem("test-project")), null);
    await button("取消").click();
    await page.getByRole("radio", { name: "短剧", exact: true }).click();
    await page.getByRole("button", { name: /新建短剧项目/ }).click();
    await page.getByLabel("新项目名称").fill("夜雨来信");
    await page.evaluate(() => {
      window.testChooseDirectory = true;
    });
    await button("选择保存位置…").click();
    await expect(page.getByRole("main", { name: "短剧工作室" })).toBeVisible();
    await assertViewport("短剧");
    await expect(page.getByRole("heading", { name: "把剧本交给灵可" })).toBeVisible();
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      const fileHeight = (await page.locator(".drama-file-drop").boundingBox()).height;
      if (width === 1440) await page.screenshot({ path: `${output}/drama-source-${scheme}.png` });
      await button("粘贴正文").click();
      assert.equal((await page.locator(".drama-paste-pane").boundingBox()).height, fileHeight);
      await button("上传剧本 / 小说").click();
    }
    await button("返回首页").click();
    await page.getByRole("button", { name: /夜雨来信.*本地素材/ }).click();
    await expect(button("选择文件")).toBeVisible();
    await page.evaluate(() => localStorage.setItem("drama-ready", "1"));
    await page.reload();
    await page.getByRole("button", { name: /夜雨来信.*本地素材/ }).click();
    await expect(page.getByRole("tab", { name: "总览" })).toHaveAttribute("aria-selected", "true");
    await button("小灵").click();
    await expect(page.getByRole("complementary", { name: "短剧小灵" })).toBeVisible();
    await button("小灵").click();
    await expect(page.getByRole("complementary", { name: "短剧小灵" })).toHaveCount(0);
    await page.getByRole("tab", { name: "片场", exact: true }).click();
    await page
      .getByRole("group", { name: "视图", exact: true })
      .getByRole("button", { name: "画布", exact: true })
      .click();
    const slot = page
      .locator(".drama-canvas-slot")
      .filter({ has: page.locator(".canvas-workspace") });
    await expect(slot).toBeVisible();
    const slotBounds = await slot.boundingBox();
    assert.ok(slotBounds.width > 0 && slotBounds.height > 0);
    assert.deepEqual(
      await slot.locator(".canvas-workspace").boundingBox(),
      slotBounds,
      "片场画布应贴合插槽",
    );
    await assertViewport("片场内嵌画布");
    await button("返回首页").click();
    await page.getByRole("radio", { name: "画布", exact: true }).click();
    await page.getByRole("button", { name: /新建画布项目/ }).click();
    await page.getByLabel("新项目名称").fill("夜雨来信");
    await page.evaluate(() => {
      window.testChooseDirectory = true;
    });
    await button("选择保存位置…").click();
    await expect(page.getByRole("main", { name: "创作画布" })).toBeVisible();
    await assertViewport("画布");
    await page.mouse.move(width / 2, 380);
    await page.mouse.wheel(75, 140);
    await assertViewport("画布滚轮");
    await page.getByRole("button", { name: "画布菜单", exact: true }).click();
    const projectMenu = page.getByRole("menu", { name: "画布菜单", exact: true });
    await expect(projectMenu.getByRole("menuitem")).toHaveText([
      "返回项目列表",
      "新建画布项目",
      "导出画布文件…",
    ]);
    await page.keyboard.press("Escape");
    const toolbar = page.getByRole("toolbar", { name: "画布编辑" });
    await toolbar.getByRole("button", { name: "素材", exact: true }).click();
    await page.getByRole("menuitem", { name: "项目素材", exact: true }).click();
    await expect(page.getByRole("region", { name: "项目文件" })).toBeVisible();
    await button("关闭项目文件").click();
    await toolbar.getByRole("button", { name: "素材", exact: true }).click();
    await page.getByRole("menuitem", { name: "从资产库添加", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "资产库", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    const drawer = page.getByRole("dialog", { name: "生成任务" });
    for (const [theme, background] of [
      ["浅色", "rgb(255, 255, 255)"],
      ["深色", "rgb(27, 27, 27)"],
    ]) {
      await button("更多").click();
      await page.getByRole("menuitem", { name: "主题", exact: true }).press("ArrowRight");
      await page.getByRole("menuitemradio", { name: theme, exact: true }).click();
      await toolbar.getByRole("button", { name: "任务", exact: true }).click();
      await expect(drawer).toHaveCSS("background-color", background);
      await expect(drawer.getByRole("button", { name: "画布历史" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await assertReadable(drawer.getByText("这张画布还没有生成过内容。"));
      await drawer.getByRole("button", { name: "任务管理" }).click();
      const center = drawer.getByRole("region", { name: "生成任务中心" });
      await expect(center).toBeVisible();
      await assertReadable(center.getByRole("button", { name: /^全部/ }));
      if (width === 1440) await drawer.screenshot({ path: `${output}/canvas-tasks-${theme}.png` });
      await button("关闭任务").click();
    }
    await page.locator(".canvas-text-preview").click();
    const strip = page.getByRole("toolbar", { name: "对白 的功能区" });
    await expect(strip.getByRole("button", { name: "生成内容", exact: true })).toHaveCount(1);
    await strip.getByRole("button", { name: "节点属性", exact: true }).click();
    await expect(page.getByRole("region", { name: "节点属性" })).toBeVisible();
    await button("关闭侧栏").click();
    await button("更多").click();
    await page.getByRole("menuitem", { name: "应用设置", exact: true }).click();
    await button("返回夜雨来信").click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await assertViewport("返回项目");
    await button("画布菜单").click();
    await page.getByRole("menuitem", { name: "返回项目列表", exact: true }).click();
    await expect(button("导入为新画布…")).toBeVisible();
    await expect(button("作为短剧打开")).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem("legacy-drama", "1"));
    await page.reload();
    await button("作为短剧打开").click();
    await expect(page.getByRole("main", { name: "短剧工作室" })).toBeVisible();
    await button("返回画布").click();
    await expect(page.getByRole("main", { name: "创作画布" })).toBeVisible();
    assert.deepEqual(errors, []);
    console.log(`通过 ${width}px 首页、设置、短剧助手、片场画布、项目菜单与任务抽屉双主题`);
    await page.close();
  }
} finally {
  await browser.close();
}
