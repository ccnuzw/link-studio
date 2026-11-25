import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { fakeGo } from "../../packages/agent-runtime/upstream/test/fake-go";
import { createCanvasProject, projectAction } from "./workspace-actions";

test("M0 Agent spike：包内 SQLite/QuickJS 可运行，模型等待期间 UI/IPC 可响应", async () => {
  const directory = await mkdtemp(join(tmpdir(), "link-studio-agent-e2e-"));
  const server = await fakeGo({
    turns: [
      {
        tools: [
          {
            id: "desktop-write",
            name: "canvas_apply_ops",
            args: {
              expectedRevision: 1,
              value: { desktop: true },
            },
          },
        ],
      },
      { text: "等待用户", hang: true },
    ],
  });
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env: {
      ...environment,
      LINK_STUDIO_TEST_USER_DATA: join(directory, "userData"),
      LINK_STUDIO_TEST_PROJECT_PARENT: directory,
    },
  });
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page);
    await expect(page.getByRole("heading", { name: "从一个节点开始" })).toBeVisible();
    await application.evaluate(
      async ({ app }, input) => {
        const root = app.isPackaged ? `${process.resourcesPath}/agent-runtime` : input.runtime;
        const loader = process.getBuiltinModule("module").createRequire(`${root}/harness.cjs`);
        const { AgentWorkerClient } = loader(`${root}/client.cjs`);
        const events: { type: string }[] = [];
        const client = await AgentWorkerClient.open({
          workerPath: `${root}/worker.mjs`,
          directory: input.directory,
          modelBridgeUrl: input.url,
          onEvent: (event: { type: string }) => events.push(event),
        });
        Reflect.set(globalThis, "linkStudioAgentSpike", { client, events });
        const scope = { kind: "canvas", projectId: "desktop-test" };
        const { sessionId } = await client.request("create", { scope });
        const run = await client.request("start", { scope, sessionId, message: "桌面验证" });
        Object.assign(Reflect.get(globalThis, "linkStudioAgentSpike"), { scope, sessionId, run });
      },
      { runtime: join(process.cwd(), "out/agent-runtime"), directory, url: server.url },
    );
    await expect
      .poll(() =>
        application.evaluate(() =>
          Reflect.get(globalThis, "linkStudioAgentSpike").events.some(
            (event: { type: string }) => event.type === "tool.end",
          ),
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: /^图片生成 文字或参考图/ }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await projectAction(page, "运行环境");
    await expect(page.getByText("桌面连接正常")).toBeVisible();
    const result = await application.evaluate(async () => {
      const state = Reflect.get(globalThis, "linkStudioAgentSpike");
      const sandbox = await state.client.request("sandbox", {
        code: "return [typeof process,typeof fetch,6*7];",
      });
      const timeout = await state.client.request("sandbox", { code: "while(true){}" });
      await state.client.request("cancel", {
        scope: state.scope,
        sessionId: state.sessionId,
        runId: state.run.id,
      });
      await state.client.request("idle");
      const persisted = await state.client.request("state", {
        scope: state.scope,
        sessionId: state.sessionId,
      });
      return { sandbox, timeout, persisted };
    });
    expect(result.sandbox).toMatchObject({ ok: true, value: ["undefined", "undefined", 42] });
    expect(result.timeout).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(result.persisted.target).toEqual({ revision: 2, value: { desktop: true } });
    expect(result.persisted.runs[0].status).toBe("canceled");
  } finally {
    await application
      .evaluate(async () => {
        await Reflect.get(globalThis, "linkStudioAgentSpike")?.client.close();
      })
      .catch(() => undefined);
    await application.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
