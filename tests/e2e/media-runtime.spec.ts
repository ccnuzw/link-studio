import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { createCanvasProject, projectAction } from "./workspace-actions";

test("M0 媒体 spike：Main 中转码期间界面和受限 IPC 可响应取消", async () => {
  test.skip(process.platform !== "darwin" || process.arch !== "arm64");
  const temporary = await mkdtemp(join(tmpdir(), "link-studio-media-e2e-"));
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const binary = join(process.cwd(), "out/media/darwin-arm64/ffmpeg");
  const source = join(temporary, "source.mp4");
  const target = join(temporary, "output.mp4");
  await runMediaProcess(binary, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=30",
    "-c:v",
    "h264_videotoolbox",
    "-allow_sw",
    "1",
    "-b:v",
    "1200000",
    "-pix_fmt",
    "yuv420p",
    "-an",
    source,
  ]);
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
      LINK_STUDIO_TEST_USER_DATA: join(temporary, "userData"),
      LINK_STUDIO_TEST_PROJECT_PARENT: temporary,
    },
  });
  try {
    const page = await application.firstWindow();
    await createCanvasProject(page);
    await expect(page.getByRole("heading", { name: "从一个节点开始" })).toBeVisible();
    await application.evaluate(
      async ({ app }, input) => {
        const runtime = app.isPackaged
          ? `${process.resourcesPath}/media-runtime/index.cjs`
          : input.runtime;
        const root = app.isPackaged
          ? `${process.resourcesPath}/media/darwin-arm64`
          : input.binaryRoot;
        const loader = process
          .getBuiltinModule("module")
          .createRequire(`${process.resourcesPath}/media-spike.cjs`);
        const { MediaComposer } = loader(runtime);
        const controller = new AbortController();
        const state = { active: true, progress: 0, code: "", controller };
        Reflect.set(globalThis, "linkStudioMediaSpike", state);
        const composer = new MediaComposer({
          ffmpeg: `${root}/ffmpeg`,
          ffprobe: `${root}/ffprobe`,
        });
        composer
          .export(
            { videos: Array(8).fill(input.source), target: input.target, profile: "hd-720p" },
            {
              signal: controller.signal,
              onProgress: (seconds: number) => {
                state.progress = seconds;
              },
            },
          )
          .then(
            () => {
              state.code = "succeeded";
            },
            (error: { code: string }) => {
              state.code = error.code;
            },
          )
          .finally(() => {
            state.active = false;
          });
      },
      {
        source,
        target,
        runtime: join(process.cwd(), "out/media-runtime/index.cjs"),
        binaryRoot: join(process.cwd(), "out/media/darwin-arm64"),
      },
    );
    await expect
      .poll(
        () => application.evaluate(() => Reflect.get(globalThis, "linkStudioMediaSpike").progress),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    expect(
      await application.evaluate(() => Reflect.get(globalThis, "linkStudioMediaSpike").active),
    ).toBe(true);
    await page.getByRole("button", { name: /^图片生成 文字或参考图/ }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await projectAction(page, "运行环境");
    await expect(page.getByText("桌面连接正常")).toBeVisible();
    await application.evaluate(() =>
      Reflect.get(globalThis, "linkStudioMediaSpike").controller.abort(),
    );
    await expect
      .poll(() => application.evaluate(() => Reflect.get(globalThis, "linkStudioMediaSpike").code))
      .toBe("EXPORT_CANCELLED");
  } finally {
    await application
      .evaluate(() => Reflect.get(globalThis, "linkStudioMediaSpike")?.controller.abort())
      .catch(() => undefined);
    await expect
      .poll(() =>
        application.evaluate(
          () => Reflect.get(globalThis, "linkStudioMediaSpike")?.active ?? false,
        ),
      )
      .toBe(false);
    await application.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
