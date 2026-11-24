import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("全能参考按原顺序展示前一百个音色，选择去重并进入豆包请求", async () => {
  const directory = await mkdtemp(join(tmpdir(), "link-studio-voice-trial-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      const api = window.desktop.settings;
      const channel = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "voice-test-key",
        fields: {
          name: "音色测试",
          endpoint: "https://example.invalid",
          allowLocal: false,
          enabled: true,
          sort: 100,
          headers: [],
        },
      });
      const catalog = await api.list({});
      const plugin =
        catalog.ok && catalog.value.plugins.find((entry) => entry.key === "doubao-video");
      if (!channel.ok || !plugin) throw Error("缺少音色协议或渠道");
      const model = await api.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        upstreamModel: "doubao-seedance-2-0",
        pluginHash: plugin.hash,
        enabled: false,
        settings: {},
        config: {
          kind: "video",
          name: "音色试跑",
          description: "",
          sort: 100,
          promptLimit: 6,
          modes: ["omni", "t2v"],
          refs: { audio: { max: 2, mb: 10 } },
        },
      });
      if (!model.ok) throw Error(model.code);
    });
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "测试 音色试跑", exact: true }).click();
    const trial = page.getByRole("dialog", { name: "测试 音色试跑" });
    const picker = trial.getByRole("button", { name: "音色库" });
    const modes = trial.getByRole("radiogroup", { name: "生成方式" });
    await expect(modes.getByRole("radio")).toHaveText(["全能参考", "文生视频"]);
    await expect(modes.getByRole("radio", { name: "全能参考" })).toBeChecked();
    await trial.getByLabel("测试提示词").fill("先检验参考");
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(trial.getByRole("alert")).toHaveText("全能参考需要至少 1 个参考素材");
    await expect(trial.getByRole("tab", { name: "结果", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const items = trial.getByRole("menuitem");
    const first = "Young - Male - Zayne 2.0",
      last = "Middle-aged - Female - Anna";
    await picker.click();
    await expect(items).toHaveCount(100);
    await expect(items.first()).toHaveText(first);
    await expect(items.last()).toHaveText(last);
    await items.last().scrollIntoViewIfNeeded();
    await expect(items.last()).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(picker).toBeFocused();
    for (const name of [first, first, last]) {
      await picker.click();
      await trial.getByRole("menuitem", { name, exact: true }).click();
      await expect(trial.getByRole("menu")).toHaveCount(0);
    }
    await expect(picker).toBeDisabled();
    const prompt = trial.getByLabel("测试提示词");
    const exactPrompt = "🎵".repeat(6);
    await prompt.fill(`${exactPrompt}音`);
    await expect(trial.getByText("7 / 6", { exact: true })).toBeVisible();
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveAttribute("aria-invalid", "true");
    await expect(trial.getByRole("alert")).toHaveText("提示词不能超过 6 个字");
    await expect(trial.getByRole("tab", { name: "结果", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await prompt.fill(exactPrompt);
    await expect(trial.getByText("6 / 6", { exact: true })).toBeVisible();
    await expect(prompt).toHaveAttribute("aria-invalid", "false");
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    const request = trial.getByRole("tabpanel", { name: "请求描述" }).locator("pre");
    await expect(request).toContainText("reference_audio");
    await expect(request).toContainText(exactPrompt);
    const original = await request.innerText();
    const requestPanel = trial.getByRole("tabpanel", { name: "请求描述" });
    await expect(requestPanel.locator("time")).toHaveAttribute("datetime", /^\d{4}-/);
    await requestPanel.getByRole("button", { name: "收起" }).press("Enter");
    await expect(request).toHaveText(
      original.split("\n").slice(0, 12).join("\n").slice(0, 1500) + "\n…",
      { useInnerText: true },
    );
    await requestPanel
      .getByRole("button", { name: `展开全部（${original.length} 字符）` })
      .press("Space");
    expect(await request.innerText()).toBe(original);
    expect(JSON.parse(await request.innerText()).json.content.slice(1)).toEqual(
      ["fz-asset-20260908172456-9zvzx-audio.wav", "fz-asset-20260908172605-qjqkx-audio.mp3"].map(
        (key) => ({
          type: "audio_url",
          role: "reference_audio",
          audio_url: { url: `https://img.vbing.site/official-voices/${key}` },
        }),
      ),
    );
    await trial.getByRole("button", { name: `移除素材 ${first}` }).click();
    await expect(picker).toBeEnabled();
    await expect(trial.getByRole("button", { name: `移除素材 ${last}` })).toBeVisible();
    await modes.getByRole("radio", { name: "文生视频" }).click();
    await expect(picker).toHaveCount(0);
    await expect(trial.getByText("当前方式只用文字，不使用参考素材")).toBeVisible();
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(request).toContainText(exactPrompt);
    await expect(request).not.toContainText("reference_audio");
    await modes.getByRole("radio", { name: "全能参考" }).click();
    await expect(trial.getByRole("button", { name: `移除素材 ${last}` })).toBeVisible();
    const lastPreview = await request.innerText();
    await app.evaluate(({ ipcMain }) => {
      const method = "link-studio:settings:modelTrial";
      ipcMain.removeHandler(method);
      let attempts = 0;
      ipcMain.handle(method, () =>
        ++attempts === 1
          ? { ok: false, code: "MODEL_TRIAL_BUSY" }
          : {
              ok: true,
              value: {
                status: "failed",
                error: "PLUGIN_RUNNER_CRASHED",
                logs: [],
                trace: [],
                outputs: [],
              },
            },
      );
    });
    const resultTab = trial.getByRole("tab", { name: "结果", exact: true });
    await resultTab.click();
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(page.getByRole("region", { name: "试跑通知" })).toContainText(
      "当前渠道已达到生成并发上限。",
    );
    await expect(resultTab).toHaveAttribute("aria-selected", "true");
    await trial.getByRole("tab", { name: "请求描述", exact: true }).click();
    expect(await request.innerText()).toBe(lastPreview);
    await resultTab.click();
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(requestPanel.getByRole("alert")).toContainText(
      "插件运行器暂时不可用，稍后重试。测试参数已保留。",
    );
    await expect(request).toHaveCount(0);
    await expect(prompt).toHaveValue(exactPrompt);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("图生图试跑保留已添加的素材，单项移除后释放名额", async () => {
  const directory = await mkdtemp(join(tmpdir(), "link-studio-trial-media-"));
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: directory };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    const windowHandle = await app.browserWindow(page);
    await windowHandle.evaluate((win) => win.setContentSize(1024, 700));
    await page.evaluate(async () => {
      const api = window.desktop.settings;
      const channel = await api.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-credential",
        fields: {
          name: "图片样例",
          endpoint: "https://example.invalid",
          allowLocal: false,
          enabled: true,
          sort: 100,
          headers: [],
        },
      });
      const catalog = await api.list({});
      const plugin = catalog.ok && catalog.value.plugins.find(({ key }) => key === "openai-image");
      if (!channel.ok || !plugin) throw new Error("缺少图片协议或渠道");
      const model = await api.modelSave({
        expectedRevision: 0,
        channelId: channel.value.id,
        channelRevision: channel.value.revision,
        upstreamModel: "gpt-image-1",
        enabled: false,
        pluginHash: plugin.hash,
        settings: {},
        config: {
          kind: "image",
          name: "图片试跑",
          description: "",
          sort: 100,
          refs: { image: { max: 2, mb: 1 } },
          params: { quality: { values: ["medium", "high"], default: "high" } },
          pricing: {
            unit: "request",
            input: 8,
            tiers: [{ on: true, when: { op: "i2i" }, unit: 12 }],
          },
        },
      });
      if (!model.ok) throw new Error(model.code);
    });
    await page.getByRole("button", { name: "应用设置" }).click();
    await page.getByRole("button", { name: "测试 图片试跑", exact: true }).click();
    const trial = page.getByRole("dialog", { name: "测试 图片试跑" });
    await expect(trial.getByRole("button", { name: "开始测试 · 8 积分" })).toBeVisible();
    await trial.getByRole("radio", { name: "图生图", exact: true }).click();
    await expect(trial.getByRole("button", { name: "开始测试 · 12 积分" })).toBeVisible();
    await trial.getByLabel("测试提示词").fill("测试参考");
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(trial.getByRole("alert")).toHaveText("图生方式需要至少 1 张参考图片");
    const picker = trial.locator('input[type="file"]');
    const canvasSources = trial.getByRole("button", { name: "画布素材" });
    await canvasSources.click();
    await expect(trial.getByRole("menu")).toContainText("画布里还没有可用的参考图片");
    await page.keyboard.press("Escape");
    await expect(trial.getByRole("menu")).toHaveCount(0);
    await expect(canvasSources).toBeFocused();
    const chooseFile = page.waitForEvent("filechooser");
    await trial.getByRole("button", { name: "上传", exact: true }).click();
    await (await chooseFile).setFiles([]);
    const image = (name: string) => ({
      name,
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+pP9kAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await picker.setInputFiles([image("一.png"), image("二.png"), image("三.png")]);
    await expect(trial.getByRole("alert")).toHaveText("参考素材数量已达上限");
    await picker.setInputFiles(image("一.png"));
    await picker.setInputFiles(image("二.png"));
    await expect(picker).toBeDisabled();
    await expect(canvasSources).toBeDisabled();
    await expect(trial.getByRole("img", { name: "二.png" })).toHaveJSProperty("naturalWidth", 1);
    await trial.getByLabel("测试提示词").fill("素材请求预览");
    await trial.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect(trial.getByRole("tabpanel", { name: "请求描述" })).toContainText(
      "/v1/images/edits",
    );
    expect(await trial.locator("aside").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(trial.getByRole("tab", { name: "结果", exact: true })).toBeInViewport();
    await trial.getByRole("button", { name: "移除素材 一.png" }).click();
    await expect(trial.getByRole("button", { name: "移除素材 二.png" })).toBeVisible();
    await expect(picker).toBeEnabled();
    await expect(canvasSources).toBeEnabled();
    await trial.getByRole("radio", { name: "文生图", exact: true }).click();
    await expect(picker).toHaveCount(0);
    await trial.getByRole("radio", { name: "图生图", exact: true }).click();
    await expect(trial.getByRole("button", { name: "移除素材 二.png" })).toBeVisible();
    await expect(trial.getByRole("img", { name: "二.png" })).toHaveJSProperty("naturalWidth", 1);
    await trial.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: /^图片试跑/ }).click();
    const editor = page.getByRole("dialog", { name: "编辑模型" });
    await editor.getByRole("button", { name: "配置 JSON" }).click();
    const legacyDocument = editor.getByRole("textbox", { name: "配置 JSON" });
    await legacyDocument.fill(
      JSON.stringify({ ...JSON.parse(await legacyDocument.inputValue()), hint: "保留协议默认值" }),
    );
    await editor.getByRole("button", { name: "保存模型" }).click();
    await expect(editor).toBeHidden();
    await page.getByRole("button", { name: /^图片试跑/ }).click();
    await editor.getByRole("tab", { name: "能力与参数" }).click();
    const preview = editor.getByLabel("创作端预览");
    await preview.getByRole("radio", { name: "图生图", exact: true }).click();
    await preview.getByRole("combobox", { name: "生成数量" }).selectOption("2");
    await preview.locator('input[type="file"]').setInputFiles(image("预览.png"));
    await editor.getByRole("button", { name: "测试模型" }).click();
    await expect(trial.getByRole("button", { name: "开始测试 · 24 积分" })).toBeVisible();
    await expect(trial.getByRole("img", { name: "预览.png" })).toHaveJSProperty("naturalWidth", 1);
    await trial.getByRole("button", { name: "移除素材 预览.png" }).click();
    await trial.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(preview.getByRole("img", { name: "预览.png" })).toHaveCount(0);
    await expect(preview.getByRole("combobox", { name: "生成数量" })).toHaveValue("2");
    await editor.getByRole("button", { name: "关闭弹窗" }).click();
    await page
      .locator(".channel-model-heading")
      .getByRole("button", { name: "新增模型", exact: true })
      .click();
    const create = page.getByRole("dialog", { name: "新建模型" });
    await create.getByRole("button", { name: "配置 JSON" }).click();
    const field = create.getByRole("textbox", { name: "配置 JSON" });
    const blank = JSON.parse(await field.inputValue());
    await field.fill(
      JSON.stringify({
        ...blank,
        kind: "video",
        label: "视频声音报价",
        channels: [
          {
            ...blank.channels[0],
            upstream_model: "doubao-seedance-2-0",
            protocol: { plugin: "doubao-video" },
          },
        ],
        capabilities: {
          ops: ["t2v"],
          params: {
            duration: {
              type: "number",
              label: "视频时长",
              open: true,
              min: 5,
              max: 9,
              step: 2,
              default: 5,
              unit: "秒",
            },
            generate_audio: {
              type: "boolean",
              label: "生成音频",
              open: true,
              default: true,
              spec: true,
            },
            resolution: {
              type: "enum",
              label: "清晰度",
              open: false,
              options: ["720P", "1080P", "4K"],
              default: "720P",
              spec: true,
            },
          },
        },
        pricing: {
          billing: "per_second",
          per_second: 2,
          tiers: [{ on: true, when: { generate_audio: true, resolution: "720P" }, unit: 3 }],
        },
      }),
    );
    await create.getByRole("button", { name: "保存模型" }).click();
    await expect(create).toBeHidden();
    await page.getByRole("button", { name: "测试 视频声音报价", exact: true }).click();
    const video = page.getByRole("dialog", { name: "测试 视频声音报价" });
    const sound = video.getByRole("radiogroup", { name: "生成音频", exact: true });
    await expect(video.getByRole("radiogroup", { name: "清晰度", exact: true })).toHaveCount(0);
    await expect(sound.getByRole("radio", { name: "开启" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await video.getByLabel("测试提示词").fill("视频示例");
    for (const [useAudio, credits] of [
      [true, 15],
      [false, 10],
    ] as const) {
      if (!useAudio) await sound.getByRole("radio", { name: "关闭", exact: true }).click();
      await expect(video.getByRole("button", { name: `开始测试 · ${credits} 积分` })).toBeVisible();
      await video.getByRole("button", { name: "只看请求（不发送）" }).click();
      await expect
        .poll(async () => {
          const text = await video
            .getByRole("tabpanel", { name: "请求描述" })
            .locator("pre")
            .textContent();
          return JSON.parse(text ?? "{}").json;
        })
        .toMatchObject({ duration: 5, generate_audio: useAudio, resolution: "720P" });
    }
    const slider = video.getByRole("slider", { name: "视频时长" });
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(slider).toHaveValue("7");
    await expect(video.getByRole("button", { name: "开始测试 · 14 积分" })).toBeVisible();
    await video.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect
      .poll(
        async () =>
          JSON.parse(
            await video.getByRole("tabpanel", { name: "请求描述" }).locator("pre").innerText(),
          ).json.duration,
      )
      .toBe(7);
    await video.getByRole("spinbutton", { name: "视频时长（数值）" }).fill("");
    await expect(slider).toHaveValue("5");
    await video
      .locator(".model-dialog-head")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page.getByRole("button", { name: /^视频声音报价/ }).click();
    await editor.getByRole("tab", { name: "能力与参数" }).click();
    await editor.getByLabel("视频时长最小").fill("10");
    await editor.getByRole("button", { name: "保存模型" }).click();
    await expect(editor.getByLabel("视频时长最小")).toBeFocused();
    await editor.getByLabel("视频时长最小").fill("5");
    await editor.getByLabel("视频时长最大").fill("11");
    await editor.getByLabel("视频时长默认").fill("7");
    const audioRow = editor
      .getByRole("group", { name: "生成音频", exact: true })
      .filter({ has: page.getByRole("button", { name: "上移" }) });
    await audioRow.getByRole("button", { name: "上移" }).click();
    await expect(audioRow.getByRole("button", { name: "上移" })).toBeDisabled();
    const orderedPreview = editor.getByLabel("创作端预览");
    const mute = orderedPreview.getByRole("radio", { name: "关闭", exact: true });
    await mute.focus();
    await mute.press("Tab");
    await expect(orderedPreview.getByRole("slider", { name: "视频时长" })).toBeFocused();
    await editor.getByLabel("duration 的展示名").fill("片长");
    await editor.getByRole("switch", { name: "生成音频 开放给用户" }).press("Space");
    await editor.getByRole("switch", { name: "生成音频 默认开启" }).press("Space");
    await editor.getByLabel("resolution 的展示名").fill("视频分辨率");
    await editor.getByRole("button", { name: "设 4K 为默认值" }).click();
    await editor.getByRole("button", { name: "保存模型" }).click();
    await expect(editor).toBeHidden();
    await page.getByRole("button", { name: /^视频声音报价/ }).click();
    await editor.getByRole("button", { name: "配置 JSON" }).click();
    const savedParams = JSON.parse(
      await editor.getByLabel("配置 JSON", { exact: true }).inputValue(),
    ).capabilities.params;
    expect(Object.keys(savedParams)).toEqual(["generate_audio", "duration", "resolution"]);
    expect(savedParams.duration).toMatchObject({
      type: "number",
      label: "片长",
      min: 5,
      max: 11,
      step: 2,
      default: 7,
    });
    expect(savedParams.resolution).toMatchObject({
      label: "视频分辨率",
      open: false,
      default: "4K",
      options: ["720P", "1080P", "4K"],
    });
    expect(savedParams.generate_audio).toMatchObject({ open: false, default: false, spec: true });
    await editor.getByRole("button", { name: "回到表单" }).click();
    await editor.getByRole("tab", { name: "积分定价", exact: true }).click();
    await expect(editor.getByRole("columnheader", { name: "默认 7秒" })).toBeVisible();
    await expect(
      editor
        .getByRole("table", { name: "规格报价" })
        .getByRole("cell", { name: "14", exact: true })
        .first(),
    ).toBeVisible();
    await editor.getByRole("button", { name: "测试模型" }).click();
    await expect(video.getByRole("slider", { name: "片长" })).toHaveValue("7");
    await expect(sound).toHaveCount(0);
    await video.getByLabel("测试提示词").fill("复核固定静音");
    await expect(video.getByRole("button", { name: "开始测试 · 14 积分" })).toBeVisible();
    await video.getByRole("button", { name: "只看请求（不发送）" }).click();
    await expect
      .poll(
        async () =>
          JSON.parse(
            await video.getByRole("tabpanel", { name: "请求描述" }).locator("pre").innerText(),
          ).json,
      )
      .toMatchObject({ duration: 7, generate_audio: false, resolution: "4K" });
    await video.getByRole("button", { name: "关闭", exact: true }).click();
    await editor.getByRole("tab", { name: "积分定价", exact: true }).click();
    const tier = editor.locator('[data-field="tier-0"]');
    await expect(
      tier.getByRole("group", { name: "生成音频" }).getByRole("button", { name: "开启" }),
    ).toHaveAttribute("aria-pressed", "true");
    await tier
      .getByRole("group", { name: "生成音频" })
      .getByRole("button", { name: "关闭" })
      .press("Enter");
    await tier.getByRole("switch", { name: "第 1 条规格价格积分成本" }).press("Space");
    await tier.getByRole("spinbutton", { name: "第 1 条规格价格积分成本" }).fill("4");
    await expect(tier).toContainText("利润率 -33%");
    await editor.getByRole("button", { name: "删除第 1 条规格价格" }).click();
    await editor.getByRole("button", { name: "按规格定价" }).click();
    await editor.getByRole("button", { name: "新增规格价格" }).click();
    await editor.getByRole("spinbutton", { name: "第 1 条规格价格", exact: true }).fill("2");
    await editor.getByRole("button", { name: "统一价格" }).click();
    await expect(editor.getByRole("spinbutton", { name: "默认价格" })).toHaveValue("2");
    await editor.getByRole("tab", { name: "能力与参数" }).click();
    await editor.getByRole("button", { name: "删除参数 generate_audio" }).click();
    await editor.getByRole("button", { name: "保存模型" }).click();
    await expect(editor).toBeHidden();
    await page.getByRole("button", { name: "测试 视频声音报价", exact: true }).click();
    await video.getByLabel("测试提示词").fill("复核移除后的请求");
    await video.getByRole("button", { name: "只看请求（不发送）" }).click();
    const requestBody = video.getByRole("tabpanel", { name: "请求描述" }).locator("pre");
    await expect(requestBody).toContainText("4K");
    expect(JSON.parse(await requestBody.innerText()).json).not.toHaveProperty("generate_audio");
    await video.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .locator(".channel-model-heading")
      .getByRole("button", { name: "新增模型", exact: true })
      .click();
    await create.getByLabel("展示名称").fill("视频模板验证");
    await create.getByRole("button", { name: "视频", exact: true }).click();
    await create.getByRole("radio", { name: /^豆包（火山方舟）/ }).click();
    await create.getByLabel("上游模型标识").fill("doubao-seedance-2-0-template");
    await create.getByRole("button", { name: "保存模型" }).click();
    await expect(create).toBeHidden();
    await page.getByRole("button", { name: /^视频模板验证/ }).click();
    await editor.getByRole("button", { name: "配置 JSON" }).click();
    const template = JSON.parse(
      await editor.getByRole("textbox", { name: "配置 JSON" }).inputValue(),
    );
    expect(template).toMatchObject({
      deadline: "1800s",
      capabilities: {
        ops: ["t2v", "i2v", "omni"],
        refs: { video: { on: true, max: 1, max_mb: 100 } },
        params: {
          resolution: { options: ["720P", "1080P", "4K"] },
          count: { options: [1, 2, 4], fanout: true },
          duration: { min: 5, max: 10, default: 5 },
          generate_audio: { default: true, spec: true },
        },
      },
      pricing: { billing: "per_second", per_second: 2 },
    });
    expect(template.pricing.tiers.map((tier: { unit: number }) => tier.unit)).toEqual([3, 4, 5, 8]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
