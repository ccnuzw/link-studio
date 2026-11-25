import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { AssetService } from "../../src/main/project/assets";
import { ProjectStore } from "../../src/main/project/store";
import { requireTestValue } from "../require-test-value";
import { chooseAssistantModel } from "./assistant-theme";
import { projectAction } from "./workspace-actions";

const avatar =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=";
const voice =
  "T2dnUwACAAAAAAAAAACgCKTfAAAAAGIERBUBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAKAIpN8BAAAAvcMZTQE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAyAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMiBsaWJvcHVzT2dnUwAEOBAAAAAAAACgCKTfAgAAAJcZJUsFAwMDAwP4//74//74//74//74//4=";

test("画布小灵：角色音色不能静默丢弃，改用全能参考后由用户审批", async () => {
  test.setTimeout(65_000);
  const root = await mkdtemp(join(tmpdir(), "link-role-reference-"));
  const binaries =
    process.env.LINK_STUDIO_MEDIA_DIRECTORY ??
    join(process.cwd(), "out/media", `${process.platform}-${process.arch}`);
  const movie = join(root, "take.mp4");
  const alternatives = ["街口", "门铃", "信封"];
  const alternativeIds = alternatives.map((_, index) => `alternative-${index}`);
  let origin = "";
  let received: unknown;
  let modelTaskId: string | undefined;
  let submits = 0,
    turn = 0,
    recovered = false;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      if (request.url === "/take.mp4")
        response.writeHead(200, { "content-type": "video/mp4" }).end(await readFile(movie));
      else if (request.url?.endsWith("/tasks/role-video"))
        response.end(
          JSON.stringify({ status: "succeeded", content: { video_url: `${origin}/take.mp4` } }),
        );
      else response.writeHead(404).end();
      return;
    }
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString());
    if (request.url?.endsWith("/tasks")) {
      submits++;
      received = payload;
      response.end(JSON.stringify({ id: "role-video" }));
      return;
    }
    const main = payload.tools?.some(
      (item: { function: { name: string } }) => item.function.name === "generate_media",
    );
    let tool: { name: string; args: unknown } | undefined;
    let text = "角色镜头";
    if (main) {
      turn++;
      if (turn === 1 || turn === 4)
        tool = { name: "canvas_get_state", args: { nodeIds: ["shot", "role", ...alternativeIds] } };
      if (turn === 2 || turn === 6)
        tool = {
          name: "generate_media",
          args: {
            items: (turn === 2 ? ["shot"] : [...alternativeIds, "shot"]).map((nodeId) => ({
              nodeId,
            })),
            wait: false,
          },
        };
      if (turn === 3) {
        recovered = payload.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === "tool" &&
            String(message.content).includes(
              '节点 "shot"（来信）：角色「林夏」的声音未带入，请选择支持参考音频的生成方式',
            ),
        );
        text = recovered ? "图生视频没有带入林夏的声音，请改用全能参考。" : "未收到声音预检结果";
      }
      if (turn === 5)
        tool = {
          name: "canvas_apply_ops",
          args: {
            ops: [
              { op: "update_node", id: "shot", mode: "omni", params: { generate_audio: true } },
            ],
          },
        };
      if (turn === 7) {
        const receipt = payload.messages.find(
          (message: { role: string; content: unknown }) =>
            message.role === "tool" &&
            typeof message.content === "string" &&
            message.content.includes("用户只批准了部分生成"),
        );
        const body = receipt?.content.match(/任务已提交：(\{[^\n]*\})。/u)?.[1];
        if (body) {
          const { tasks } = JSON.parse(body);
          if (tasks.length === 1 && tasks[0].node_id === "shot") modelTaskId = tasks[0].task_id;
        }
        text = modelTaskId ? "只提交了来信镜头。" : "没有来信镜头的任务回执。";
      }
    }
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `tool-${turn}`,
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            },
          ],
        }
      : { role: "assistant", content: text };
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        `data: ${JSON.stringify({ id: "role", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await runMediaProcess(join(binaries, "ffmpeg"), [
      "-f",
      "lavfi",
      "-i",
      "color=s=64x48:d=1",
      "-c:v",
      "h264_videotoolbox",
      "-allow_sw",
      "1",
      movie,
    ]);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing mock endpoint");
    origin = `http://127.0.0.1:${address.port}`;
    const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: root };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    app = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env,
    });
    const page = await app.firstWindow();
    const video = await page.evaluate(async (endpoint) => {
      const settings = window.desktop.settings;
      const list = await settings.list({});
      if (!list.ok) throw Error(list.code);
      let videoId = "";
      for (const key of ["openai", "doubao-video"]) {
        const hash = list.value.plugins.find((item) => item.key === key)?.hash;
        if (!hash) throw Error(key);
        const chat = key === "openai";
        if (!chat) {
          const channel = await settings.channelSave({
            expectedRevision: 0,
            approve: true,
            secret: "fixture-key",
            fields: {
              name: "视频报价",
              endpoint,
              enabled: true,
              allowLocal: true,
              sort: 1,
              headers: [],
            },
          });
          if (!channel.ok) throw Error(channel.code);
          const model = await settings.modelSave({
            expectedRevision: 0,
            channelId: channel.value.id,
            channelRevision: channel.value.revision,
            upstreamModel: "doubao-seedance-2-0-fast-260615",
            pluginHash: hash,
            settings: { as: "base64" },
            enabled: true,
            approve: true,
            config: {
              kind: "video",
              name: "角色镜头",
              description: "",
              sort: 1,
              modes: ["t2v", "i2v", "omni"],
              generateAudio: { open: true, default: false, spec: true },
              params: {
                duration: {
                  values: ["5", "6"],
                  default: "6",
                  range: { min: 5, max: 6, step: 1, open: true },
                },
              },
              pricing: {
                unit: "second",
                input: 2,
                tiers: [{ on: true, when: { op: "omni", generate_audio: true }, unit: 5 }],
              },
            },
          });
          if (!model.ok) throw Error(model.code);
          videoId = model.value.id;
          continue;
        }
        const result = await settings.save({
          expectedRevision: 0,
          pluginHash: hash,
          secret: "fixture-key",
          approve: true,
          fields: {
            model: "fixture",
            label: "角色助手",
            endpoint,
            allowLocal: true,
            agentEnabled: true,
            channel: { api: "chat_completions" },
          },
        });
        if (!result.ok) throw Error(result.code);
      }
      return videoId;
    }, origin);
    const store = await ProjectStore.create(root, "已设定音色的角色");
    const directory = store.directory;
    try {
      const service = new AssetService(join(binaries, "ffprobe"));
      async function addFile(name: string, base64: string) {
        const path = join(root, name);
        await writeFile(path, Buffer.from(base64, "base64"));
        const file = await open(path, "r");
        try {
          const operationId = randomUUID();
          const copy = await service.importCopy(store, file, name, operationId);
          if (copy.kind !== "created") throw Error("Expected new asset");
          await store.commitAsset({
            operationId,
            expectedRevision: store.snapshot.revision,
            requestHash: createHash("sha256").update(name).digest("hex"),
            asset: copy.asset,
          });
          return copy.asset.assetId;
        } finally {
          await file.close();
        }
      }
      const assetId = await addFile("林夏.png", avatar),
        voiceId = await addFile("林夏.ogg", voice);
      await store.applyCanvasOperations({
        operationId: randomUUID(),
        expectedCanvasRevision: store.getCanvas().canvasRevision,
        operations: [
          {
            type: "putNode",
            node: {
              id: "role",
              type: "creative",
              position: { x: 0, y: 0 },
              data: {
                kind: "image",
                label: "林夏",
                text: "",
                assetId,
                character: {
                  name: "林夏",
                  look: "基础形象",
                  description: "",
                  extraAssetIds: [],
                  voice: { assetId: voiceId, origin: "upload" },
                },
              },
            },
          },
          {
            type: "putNode",
            node: {
              id: "shot",
              type: "creative",
              position: { x: 660, y: 0 },
              data: {
                kind: "video",
                label: "来信",
                text: "@[林夏](node:role)念出信件",
                generation: { providerId: video },
                videoMode: "i2v",
              },
            },
          },
          { type: "putEdge", edge: { id: "reference", source: "role", target: "shot" } },
          ...alternatives.map((label, index) => ({
            type: "putNode" as const,
            node: {
              id: requireTestValue(alternativeIds[index]),
              type: "creative" as const,
              position: { x: 660 + index * 420, y: 500 },
              data: {
                kind: "video" as const,
                label,
                text: label,
                generation: { providerId: video },
                videoMode: "t2v" as const,
              },
            },
          })),
        ],
      });
    } finally {
      await store.close();
    }
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, directory);
    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    await page.getByRole("button", { name: "打开小灵", exact: true }).click();
    const assistant = page.getByRole("region", { name: "画布小灵" });
    await chooseAssistantModel(assistant.getByRole("button", { name: "Agent 模型" }), {
      name: "fixture",
    });
    const composer = assistant.getByRole("textbox", { name: "画布消息" });
    await composer.fill("把来信做成视频，要用林夏的声音。");
    await composer.press("Enter");
    await expect(
      assistant.getByText("图生视频没有带入林夏的声音，请改用全能参考。", { exact: true }),
    ).toBeVisible();
    expect(recovered).toBe(true);
    expect(submits).toBe(0);
    await expect(assistant.getByRole("heading", { name: /申请生成/ })).toHaveCount(0);
    await composer.fill("来信改成全能参考，和街口、门铃、信封一起申请。我来选，只提交。");
    await composer.press("Enter");
    await expect(assistant.getByRole("heading", { name: "申请生成 4 个节点" })).toBeVisible();
    const card = assistant.getByRole("region", { name: "待处理请求" });
    await expect(card.getByRole("heading")).toContainText("✦ 66");
    await expect(card.getByRole("option", { name: /批准生成/ })).toContainText("✦ 66");
    await expect(card.getByRole("checkbox")).toHaveCount(3);
    for (const label of alternatives)
      await card.getByRole("checkbox", { name: `生成「${label}」` }).uncheck();
    await expect(card.getByRole("heading")).toContainText("✦ 30");
    await expect(card.getByRole("option", { name: /批准生成/ })).toContainText("✦ 30");
    await expect(card.getByRole("option", { name: /批准生成/ })).toBeEnabled();
    await card.getByRole("button", { name: "还有 1 项" }).press("Enter");
    await expect(card.getByRole("checkbox")).toHaveCount(4);
    await expect(card.getByRole("checkbox", { name: "生成「来信」" })).toBeChecked();
    await assistant.getByText("查看端点和出站内容", { exact: true }).click();
    await expect(assistant.getByText(/角色声音样本只用于音色参考/).last()).toBeVisible();
    expect(submits).toBe(0);
    await assistant.getByRole("option", { name: /批准生成/ }).click();
    await expect.poll(() => submits).toBe(1);
    await expect(assistant.getByText("已批准：申请生成 4 个节点", { exact: true })).toBeVisible();
    await expect(assistant.getByText("· ✦ 30", { exact: true })).toBeVisible();
    await expect(assistant.getByText("只提交了来信镜头。", { exact: true })).toBeVisible();
    expect(received).toMatchObject({
      generate_audio: true,
      content: [
        {
          type: "text",
          text: "林夏（图片1中的人物）念出信件\n\n【人物参考】\n林夏：图片1中的人物。\n\n【人物音色对应】\n林夏（图片1中的人物）说话时，音色参考音频1。\n角色声音样本只用于音色参考，本次台词以剧情为准。",
        },
        {
          type: "image_url",
          role: "reference_image",
          image_url: { url: expect.stringContaining(avatar) },
        },
        {
          type: "audio_url",
          role: "reference_audio",
          audio_url: { url: expect.stringContaining(voice) },
        },
      ],
    });
    await projectAction(page, "生成任务");
    await expect(
      page.getByRole("region", { name: "生成任务中心" }).getByText("已完成", { exact: true }),
    ).toBeVisible({ timeout: 35_000 });
    await app.close();
    app = undefined;
    const database = new DatabaseSync(join(root, "settings", "agent.sqlite"), { readOnly: true });
    try {
      const approvals = database
        .prepare(
          "SELECT a.status,a.decision,a.result,a.quote_credits,r.spent_credits FROM agent_approvals a JOIN agent_runs r ON r.id=a.run_id WHERE a.kind='generate'",
        )
        .all();
      expect(approvals).toHaveLength(1);
      expect(requireTestValue(approvals[0]).status).toBe("executed");
      expect(approvals[0]).toMatchObject({ quote_credits: 30, spent_credits: 30 });
      expect(JSON.parse(String(requireTestValue(approvals[0]).decision)).items).toEqual([
        { index: 3, approve: true, count: 1 },
      ]);
      expect(JSON.parse(String(requireTestValue(approvals[0]).result)).tasks).toEqual([
        { node_id: "shot", task_id: modelTaskId },
      ]);
    } finally {
      database.close();
    }
    const reopened = await ProjectStore.open(directory);
    try {
      const shot = reopened.getCanvas().canvas.nodes.find((node) => node.id === "shot");
      if (shot?.type !== "creative" || !shot.data.assetId) throw Error("成片没有落回镜头节点");
      const asset = reopened.snapshot.assets[shot.data.assetId];
      expect(asset).toMatchObject({
        mediaType: "video",
        sha256: createHash("sha256")
          .update(await readFile(movie))
          .digest("hex"),
      });
      expect(shot.data.outputs).toHaveLength(1);
      expect(requireTestValue(shot.data.outputs)[0]).toMatchObject({
        assetId: requireTestValue(asset).assetId,
        kind: "video",
      });
      for (const node of reopened
        .getCanvas()
        .canvas.nodes.filter((node) => alternativeIds.includes(node.id)))
        expect(node.data).not.toHaveProperty("assetId");
      expect(submits).toBe(1);
    } finally {
      await reopened.close();
    }
  } finally {
    await app?.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
