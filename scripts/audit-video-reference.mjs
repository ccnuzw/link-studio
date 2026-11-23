import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";

export async function videoFixture(cache) {
  const ffmpeg = resolve(
    "out/media",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  const file = join(cache, "ref.mp4"),
    poster = join(cache, "poster.png");
  const codec =
    process.platform === "darwin"
      ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
      : ["-c:v", "libx264"];
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=96x64:r=12:d=2",
    ...codec,
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-frames:v",
    "1",
    "-threads",
    "1",
    "-update",
    "1",
    poster,
  ]);
  return { file: await readFile(file), poster: await readFile(poster) };
}

export async function auditVideoReference({ page, origin, media, capture, zoom, reduce }) {
  let release,
    requests = 0,
    originals = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`${origin}files/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("v") === "poster") {
      requests++;
      await gate;
      return url.pathname.endsWith("bad.mp4")
        ? route.fulfill({ status: 404, body: "" })
        : route.fulfill({ contentType: "image/png", body: media.poster });
    }
    originals++;
    return route.fulfill({ contentType: "video/mp4", body: media.file });
  });
  await page.addInitScript(() => {
    window.desktop = {
      projects: {
        getAssetPreview: async ({ assetId, variant }) => ({
          ok: true,
          value: { url: `/files/${assetId}.mp4${variant ? "?v=poster" : ""}` },
        }),
      },
    };
  });
  await page.goto(`${origin}audit#video`);
  const good = page.getByRole("button", { name: "引用：镜头，点击定位到节点" }),
    bad = page.getByRole("button", { name: "引用：缺封面，点击定位到节点" });
  const skeleton = good.locator('[data-slot="media-skeleton"]');
  const strip = {
    x: 30,
    y: 30,
    width: Math.ceil(170 * zoom + 18),
    height: Math.ceil(52 * zoom + 18),
  };
  try {
    await expect.poll(() => requests).toBe(2);
    await expect(skeleton).toHaveCSS("opacity", "1");
    await expect(skeleton.locator("div")).toHaveCount(reduce ? 0 : 1);
    if (!reduce) {
      await page.locator('[data-slot="media-skeleton"] > div').evaluateAll((elements) => {
        for (const element of elements) {
          const [sweep] = element.getAnimations();
          if (!sweep || sweep.effect.getTiming().duration !== 1600)
            throw Error("缺少 1.6 秒扫光动画");
          sweep.pause();
          sweep.currentTime = 800;
        }
      });
    }
    await capture("pending", strip);
  } finally {
    release();
  }
  await expect(good.locator("img")).toHaveJSProperty("naturalWidth", 96);
  await expect(skeleton).toHaveCount(0);
  await expect(bad.locator("img")).toHaveCount(0);
  await expect(bad.locator("svg")).toHaveCount(1);
  assert.equal(originals, 0);
  await expect(page.locator("video")).toHaveCount(0);
  await capture("settled", strip);
  await good.hover();
  const video = page.locator("video");
  await expect(video).toHaveCount(1);
  await expect(video).toHaveJSProperty("videoWidth", 96);
  await expect(video).toHaveJSProperty("paused", false);
  for (const key of ["autoplay", "muted", "loop", "playsInline"])
    await expect(video).toHaveJSProperty(key, true);
  await expect.poll(() => video.evaluate((el) => el.currentTime)).toBeGreaterThan(0);
  assert(originals > 0);
  await video.evaluate(async (el) => {
    el.pause();
    await new Promise((done) => {
      el.addEventListener("seeked", done, { once: true });
      el.currentTime = 0.5;
    });
  });
  await capture("peek", { x: 0, y: 0, width: 560, height: 440 });
  await page.mouse.move(2, 2);
  await expect(video).toHaveCount(0);
  await page.keyboard.press("Tab");
  await good.focus();
  await expect(video).toHaveCount(1);
  await good.press("Escape");
  await expect(video).toHaveCount(0);
  await expect(good).toBeFocused();
}
