import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CompositionInput, MediaComposer } from "../../packages/media-runtime/src/composition";
import { runMediaProcess } from "../../packages/media-runtime/src/process";

const binaryRoot =
  process.env.LINK_STUDIO_MEDIA_DIRECTORY ?? join(process.cwd(), "out/media/darwin-arm64");
const binaries = { ffmpeg: join(binaryRoot, "ffmpeg"), ffprobe: join(binaryRoot, "ffprobe") };
const composer = new MediaComposer(binaries);
let directory: string;
let red: string;
let blue: string;
let green: string;
let shortBgm: string;
let longBgm: string;
let silent: string;

async function ffmpeg(args: string[]) {
  return runMediaProcess(binaries.ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...args,
  ]);
}

function input(name: string, extra: Partial<CompositionInput> = {}): CompositionInput {
  return {
    videos: [red, blue, green],
    target: join(directory, `${name}.mp4`),
    profile: "m0-360p",
    ...extra,
  };
}

async function pixel(path: string, seconds: number, x = 320, y = 180) {
  const bytes = await ffmpeg([
    "-ss",
    String(seconds),
    "-i",
    path,
    "-frames:v",
    "1",
    "-an",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  return [...bytes.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3)];
}

async function audio(path: string, start: number, duration = 0.2) {
  const bytes = await ffmpeg([
    "-ss",
    String(start),
    "-i",
    path,
    "-t",
    String(duration),
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1",
  ]);
  return Array.from(
    { length: bytes.length / 2 },
    (_, index) => bytes.readInt16LE(index * 2) / 32768,
  );
}

function rms(values: number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

function tone(values: number[], frequency: number) {
  let cosine = 0;
  let sine = 0;
  for (const [index, value] of values.entries()) {
    const phase = (2 * Math.PI * frequency * index) / 48000;
    cosine += value * Math.cos(phase);
    sine += value * Math.sin(phase);
  }
  return (2 * Math.hypot(cosine, sine)) / values.length;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "link-studio-media-test-"));
  red = join(directory, "红 镜头;$(unused).mp4");
  blue = join(directory, "蓝色竖屏.mp4");
  green = join(directory, "绿色.mp4");
  silent = join(directory, "静音长片.mp4");
  shortBgm = join(directory, "短音乐.wav");
  longBgm = join(directory, "长音乐.wav");
  const videoArgs = [
    "-c:v",
    "h264_videotoolbox",
    "-allow_sw",
    "1",
    "-b:v",
    "800000",
    "-pix_fmt",
    "yuv420p",
  ];
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=24:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=1",
    ...videoArgs,
    "-c:a",
    "aac",
    "-shortest",
    red,
  ]);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=180x320:r=25:d=1", ...videoArgs, "-an", blue]);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=480x270:r=30:d=1",
    ...videoArgs,
    "-an",
    green,
  ]);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:r=30:d=3",
    ...videoArgs,
    "-an",
    silent,
  ]);
  for (const [path, duration] of [
    [shortBgm, 0.65],
    [longBgm, 5],
  ] as const) {
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=880:sample_rate=44100:duration=${duration}`,
      "-c:a",
      "pcm_s16le",
      path,
    ]);
  }
}, 60_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "M0-04 FFmpeg composition",
  () => {
    it("构建没有 GPL/nonfree/网络；二进制 hash 与许可/源码随包可核对", async () => {
      const info = JSON.parse(await readFile(join(binaryRoot, "build-info.json"), "utf8"));
      for (const name of ["ffmpeg", "ffprobe"]) {
        const bytes = await readFile(join(binaryRoot, name));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(info.binaries[name].sha256);
        expect(info.binaries[name].version).toContain(
          "ffmpeg version 7.1.3".replace("ffmpeg", name),
        );
        expect(info.binaries[name].version).not.toContain("--enable-gpl");
        expect(info.binaries[name].version).not.toContain("--enable-nonfree");
        expect(info.binaries[name].dependencies).not.toContain("/opt/homebrew");
      }
      expect(await readdir(binaryRoot)).toEqual(
        expect.arrayContaining(["COPYING.LGPLv2.1", "LICENSE.md", "ffmpeg-7.1.3-source.tar.xz"]),
      );
      const protocols = (await ffmpeg(["-protocols"])).toString();
      expect(protocols).not.toMatch(/https?|tcp|udp/);
    });

    it("三镜头顺序、不同分辨率/fps、竖屏留边、源音与无音轨静音均正确", async () => {
      const result = await composer.export(input("ordered"));
      expect(result.probe.duration).toBeCloseTo(3, 1);
      expect(result.probe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({
        codec_name: "h264",
        width: 640,
        height: 360,
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
      });
      expect(result.probe.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
      });
      const colors = await Promise.all([
        pixel(result.target, 0.5),
        pixel(result.target, 1.5),
        pixel(result.target, 2.5),
      ]);
      expect(colors[0]?.[0]).toBeGreaterThan(200);
      expect(colors[1]?.[2]).toBeGreaterThan(200);
      expect(colors[2]?.[1]).toBeGreaterThan(80);
      expect(Math.max(...(await pixel(result.target, 1.5, 20, 180)))).toBeLessThan(15);
      expect(tone(await audio(result.target, 0.3), 440)).toBeGreaterThan(0.05);
      expect(rms(await audio(result.target, 1.4))).toBeLessThan(0.001);
      expect(result.recipe.sources).toHaveLength(3);
      for (const stream of result.probe.streams)
        expect(Math.abs(Number(stream.start_time ?? 0))).toBeLessThan(0.05);
    }, 30_000);

    it("短 BGM 播放结束后静音补齐，长 BGM 截断，均不改变片长", async () => {
      const short = await composer.export(
        input("short-bgm", { videos: [silent], bgm: shortBgm, sourceVolume: 0, bgmVolume: 1 }),
      );
      const long = await composer.export(
        input("long-bgm", { videos: [silent], bgm: longBgm, sourceVolume: 0, bgmVolume: 1 }),
      );
      expect(short.probe.duration).toBeCloseTo(3, 1);
      expect(long.probe.duration).toBeCloseTo(3, 1);
      expect(tone(await audio(short.target, 0.2), 880)).toBeGreaterThan(0.05);
      expect(rms(await audio(short.target, 1.8))).toBeLessThan(0.001);
      expect(tone(await audio(long.target, 2.6), 880)).toBeGreaterThan(0.05);
    }, 30_000);

    it("源音和 BGM 叠加且音量参数生效", async () => {
      const result = await composer.export(
        input("mix", { videos: [red], bgm: longBgm, sourceVolume: 0.5, bgmVolume: 0.25 }),
      );
      const values = await audio(result.target, 0.3);
      const source = tone(values, 440);
      const bgm = tone(values, 880);
      expect(source).toBeGreaterThan(0.025);
      expect(bgm).toBeGreaterThan(0.012);
      expect(source / bgm).toBeGreaterThan(1.5);
      expect(source / bgm).toBeLessThan(2.6);
    }, 30_000);

    it("源音长于画面时仍以视频流时长拼接，720p profile 可编码", async () => {
      const source = join(directory, "long-source-audio.mp4");
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x180:r=24:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=3",
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "1",
        "-b:v",
        "800000",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        source,
      ]);
      const result = await composer.export(
        input("video-duration", { videos: [source, blue], profile: "hd-720p" }),
      );
      expect(result.probe.duration).toBeCloseTo(2, 1);
      expect(result.recipe.duration).toBeCloseTo(2, 1);
      expect(result.probe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({
        width: 1280,
        height: 720,
      });
    }, 30_000);

    it("目标已存在/验证后出现竞争文件都拒绝覆盖", async () => {
      const selected = input("existing");
      await writeFile(selected.target, "original-file");
      await expect(composer.export(selected)).rejects.toMatchObject({
        code: "EXPORT_TARGET_EXISTS",
      });
      expect(await readFile(selected.target, "utf8")).toBe("original-file");
      const race = input("target-race", { videos: [blue] });
      await expect(
        composer.export(race, {
          onStage: async (stage) => {
            if (stage === "validated") await writeFile(race.target, "race-winner");
          },
        }),
      ).rejects.toMatchObject({ code: "EXPORT_TARGET_EXISTS" });
      expect(await readFile(race.target, "utf8")).toBe("race-winner");
    }, 30_000);

    it("取消、超时、工作进程失败均清理临时文件，不发布半成品", async () => {
      const controller = new AbortController();
      const cancelled = input("cancelled");
      await expect(
        composer.export(cancelled, {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
      ).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });
      await expect(composer.export(input("timeout"), { timeoutMs: 1 })).rejects.toMatchObject({
        code: "EXPORT_TIMEOUT",
      });
      const failed = new MediaComposer({ ...binaries, ffmpeg: "/usr/bin/false" });
      await expect(failed.export(input("failed"))).rejects.toMatchObject({
        code: "EXPORT_WORKER_FAILED",
      });
      const entries = await readdir(directory);
      for (const name of ["cancelled.mp4", "timeout.mp4", "failed.mp4"])
        expect(entries).not.toContain(name);
      expect(entries.some((entry) => entry.startsWith(".link-studio-export-"))).toBe(false);
    }, 30_000);

    it("无有效成品的零退出码也不能发布", async () => {
      const failed = new MediaComposer({ ...binaries, ffmpeg: "/usr/bin/true" });
      await expect(failed.export(input("empty-success"))).rejects.toThrow();
      expect(await readdir(directory)).not.toContain("empty-success.mp4");
    });

    it("配方和输入字节固定后，原文件/调用参数变化不改变当前成片", async () => {
      const mutable = join(directory, "mutable.mp4");
      await copyFile(red, mutable);
      const selected = input("immutable", { videos: [mutable] });
      const result = await composer.export(selected, {
        onStage: async (stage) => {
          if (stage === "prepared") {
            selected.videos[0] = blue;
            selected.sourceVolume = 0;
            await copyFile(blue, mutable);
          }
        },
      });
      expect((await pixel(result.target, 0.5))[0]).toBeGreaterThan(200);
      expect(result.recipe.sourceVolume).toBe(1);
      expect(tone(await audio(result.target, 0.3), 440)).toBeGreaterThan(0.05);
    }, 30_000);

    it("同目标并发第二项拒绝；事件循环在编码期间仍能响应", async () => {
      const selected = input("concurrent", { videos: [silent, silent, silent] });
      let ticks = 0;
      const timer = setInterval(() => ticks++, 5);
      try {
        const result = await composer.export(selected, {
          onStage: async (stage) => {
            if (stage === "encoding")
              await expect(composer.export(selected)).rejects.toMatchObject({
                code: "EXPORT_TARGET_BUSY",
              });
          },
        });
        expect(result.probe.duration).toBeCloseTo(9, 1);
        expect(ticks).toBeGreaterThan(3);
      } finally {
        clearInterval(timer);
      }
    }, 30_000);

    it("非法配方、缺失/损坏输入、音频冒充视频在发布前拒绝", async () => {
      await expect(
        composer.export(input("no-source", { videos: [join(directory, "missing")] })),
      ).rejects.toMatchObject({ code: "EXPORT_SOURCE_MISSING" });
      await expect(
        composer.export(input("bad-gain", { bgmVolume: Number.NaN })),
      ).rejects.toMatchObject({ code: "EXPORT_RECIPE_INVALID" });
      await expect(
        composer.export(input("audio-as-video", { videos: [shortBgm] })),
      ).rejects.toMatchObject({ code: "EXPORT_MEDIA_UNSUPPORTED" });
      const corrupt = join(directory, "corrupt.mp4");
      await writeFile(corrupt, "invalid bytes");
      await expect(composer.export(input("bad-media", { videos: [corrupt] }))).rejects.toThrow();
      expect(await readdir(directory)).not.toContain("bad-media.mp4");
    });

    it("拒绝无效 BGM 和输出探测结果，取消后同目标可以重试", async () => {
      const selected = input("retry-after-cancel", { videos: [red] });
      const controller = new AbortController();
      controller.abort();
      await expect(composer.export(selected, { signal: controller.signal })).rejects.toMatchObject({
        code: "EXPORT_CANCELLED",
      });
      expect((await composer.export(selected)).probe.duration).toBeCloseTo(1, 1);
      await expect(composer.export(input("video-as-bgm", { bgm: blue }))).rejects.toMatchObject({
        code: "EXPORT_MEDIA_UNSUPPORTED",
      });
      const invalidProbe = new MediaComposer({ ...binaries, ffprobe: "/usr/bin/true" });
      await expect(invalidProbe.export(input("invalid-probe"))).rejects.toMatchObject({
        code: "EXPORT_MEDIA_UNSUPPORTED",
      });
      expect(await readdir(directory)).not.toContain("invalid-probe.mp4");
    }, 30_000);

    it("不响应 SIGTERM 的进程被强制终止，回调异常和输出超限也终止进程", async () => {
      const controller = new AbortController();
      const started = Date.now();
      await expect(
        runMediaProcess(
          process.execPath,
          [
            "-e",
            "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
          ],
          {
            signal: controller.signal,
            onProgress: () => controller.abort(),
          },
        ),
      ).rejects.toMatchObject({ code: "EXPORT_CANCELLED" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(Date.now() - started).toBeLessThan(4000);
      await expect(
        runMediaProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], {
          maxStdoutBytes: 1024,
        }),
      ).rejects.toMatchObject({ code: "EXPORT_OUTPUT_LIMIT" });
      await expect(
        runMediaProcess(
          process.execPath,
          ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
          {
            onProgress: () => {
              throw new Error("callback");
            },
          },
        ),
      ).rejects.toMatchObject({ code: "EXPORT_PROGRESS_FAILED" });
    }, 10_000);

    it("子进程 RSS 超限时停止执行且返回稳定错误", async () => {
      await expect(
        runMediaProcess(
          process.execPath,
          ["-e", "global.buffer=Buffer.alloc(64*1024*1024,7);setInterval(()=>{},1000)"],
          { maxRssMiB: 32 },
        ),
      ).rejects.toMatchObject({ code: "EXPORT_MEMORY_LIMIT" });
    });
  },
);
