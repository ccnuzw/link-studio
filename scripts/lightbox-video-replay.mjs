import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";

export async function makeVideo(temp) {
  const clip = join(temp, "movie.mp4");
  const ffmpeg = resolve(
    "out/media",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  const encoder =
    process.platform === "darwin"
      ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
      : ["-c:v", "libx264"];
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=#729ab1:s=192x108:r=24:d=12",
    ...encoder,
    "-movflags",
    "+faststart",
    clip,
  ]);
  return readFile(clip);
}

export async function replayVideo(page, origin, clip, capture) {
  let mediaFailure = "none";
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`${origin}files/movie.mp4?v=poster`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="#d9a077"/></svg>',
    }),
  );
  await page.route(`${origin}files/movie.mp4`, async (route) => {
    await pending;
    if (route.request().resourceType() === "media" && mediaFailure !== "none") {
      if (mediaFailure === "once") mediaFailure = "none";
      return route.fulfill({ status: 503, body: "" });
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    const start = Number(range?.[1] ?? 0),
      end = Math.min(Number(range?.[2] || clip.length - 1), clip.length - 1);
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: "video/mp4",
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
        ...(range && { "content-range": `bytes ${start}-${end}/${clip.length}` }),
      },
      body: route.request().method() === "HEAD" ? undefined : clip.subarray(start, end + 1),
    });
  });
  await page.goto(`${origin}audit`, { waitUntil: "domcontentloaded" });
  const player = page.locator("video"),
    button = (name) => page.getByRole("button", { name, exact: true }),
    slider = page.getByRole("slider", { name: "播放进度" }),
    controls = slider.locator("..");
  const rects = {};
  const collect = async (name, locator) => {
    const rect = await locator.boundingBox();
    assert(rect);
    rects[name] = rect;
  };
  const poster = page.locator('img[src*="v=poster"]');
  await expect(poster).toHaveJSProperty("naturalWidth", 80);
  await expect
    .poll(async () => {
      const bounds = await player.boundingBox();
      return bounds && bounds.width / bounds.height;
    })
    .toBeCloseTo(0.8, 3);
  await expect(page.getByText("加载视频…")).toBeVisible();
  await capture("poster");
  await collect("封面", poster);
  release();
  await expect(player).toHaveJSProperty("paused", false);
  await expect(controls).toHaveCSS("opacity", "0", { timeout: 5500 });
  await expect(controls).toHaveCSS("pointer-events", "none");
  await player.hover();
  await expect(controls).toHaveCSS("opacity", "1");
  const download = button("下载原文件");
  await download.evaluate((element) =>
    element.addEventListener("click", () => (element.dataset.activated = "true")),
  );
  await download.focus();
  await page.keyboard.press("Space");
  await expect(player).toHaveJSProperty("paused", true);
  await expect(download).not.toHaveAttribute("data-activated", "true");
  await player.evaluate((video) => {
    video.currentTime = 3;
  });
  await expect(page.getByText("0:03 / 0:12")).toBeVisible();
  await collect("舞台", player);
  await collect("控制条", controls);
  await collect("滑块", slider);
  for (const name of ["播放（空格）", "倍速", "循环播放", "静音（M）"])
    await collect(name, button(name));
  await page.mouse.move(5, 5);
  await capture("initial");
  await button("播放（空格）").hover();
  await capture("play-hover");
  await page.mouse.down();
  await capture("play-pressed");
  await page.mouse.move(5, 5);
  await page.mouse.up();
  await expect(player).toHaveJSProperty("paused", true);
  await page.keyboard.press("m");
  await expect(player).toHaveJSProperty("muted", true);
  await button("循环播放").click();
  await expect(player).toHaveJSProperty("loop", true);
  await button("倍速").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveText(["0.5x", "1x", "1.5x", "2x"]);
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText("1x");
  await menu.getByRole("menuitemradio", { name: "1.5x" }).hover();
  await capture("speed-menu");
  await collect("倍速菜单", menu);
  await menu.getByRole("menuitemradio", { name: "1.5x" }).press("Enter");
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText("1.5x");
  await expect(player).toHaveJSProperty("playbackRate", 1.5);
  await expect(button("倍速")).toHaveText("1.5x");
  await page.keyboard.press("m");
  await expect(player).toHaveJSProperty("muted", true);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.mouse.move(5, 5);
  await capture("muted-loop");
  await slider.click({ position: { x: Math.floor(rects["滑块"].width / 2), y: 1 } });
  await expect.poll(() => player.evaluate((video) => Math.round(video.currentTime))).toBe(6);
  await page.keyboard.press("Space");
  await expect(player).toHaveJSProperty("paused", false);
  await page.keyboard.press("M");
  await expect(player).toHaveJSProperty("muted", false);
  await player.evaluate((video) => {
    video.currentTime = video.duration - 0.2;
  });
  await expect.poll(() => player.evaluate((video) => video.currentTime)).toBeLessThan(2);
  await expect(player).toHaveJSProperty("paused", false);
  await player.hover({ position: { x: 20, y: 20 } });
  await button("循环播放").click();
  await expect(player).toHaveJSProperty("loop", false);
  await player.evaluate((video) => {
    video.currentTime = video.duration - 0.2;
  });
  await expect(player).toHaveJSProperty("ended", true);
  await expect(button("播放（空格）")).toBeVisible();
  await player.click({ position: { x: 20, y: 20 } });
  await expect(player).toHaveJSProperty("paused", false);
  mediaFailure = "once";
  await page.reload();
  await expect(player).toHaveJSProperty("crossOrigin", null);
  await expect(player).toHaveJSProperty("videoWidth", 192);
  await expect(player).toHaveJSProperty("paused", false);
  mediaFailure = "always";
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("视频无法播放");
  await capture("video-failed");
  await collect("失败舞台", page.getByRole("alert"));
  mediaFailure = "none";
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(player).toHaveJSProperty("crossOrigin", "anonymous");
  await expect(player).toHaveJSProperty("videoWidth", 192);
  await expect(player).toHaveJSProperty("paused", false);
  await expect(page.getByRole("alert")).toHaveCount(0);
  return rects;
}
