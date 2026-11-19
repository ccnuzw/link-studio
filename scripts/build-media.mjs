import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildRuntime } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const specification = await readFile(join(root, "resources/media/build.json"), "utf8");
const build = JSON.parse(specification);
const target = `${process.platform}-${process.arch}`;
if (target !== build.target) throw new Error(`媒体构建尚未验证平台 ${target}`);
const cache = join(root, ".cache/media");
const destination = join(root, "out/media", target);
await mkdir(cache, { recursive: true });
await mkdir(destination, { recursive: true });
const sourceArchive = join(cache, `ffmpeg-${build.version}.tar.xz`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let archive = await readFile(sourceArchive).catch(() => null);
if (!archive || hash(archive) !== build.sourceSha256) {
  const response = await fetch(build.sourceUrl);
  if (!response.ok) throw new Error(`FFmpeg 源码下载失败 ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
  if (hash(archive) !== build.sourceSha256) throw new Error("FFmpeg 源码 SHA-256 不匹配");
  await writeFile(sourceArchive, archive);
}
const sourceDirectory = join(cache, `ffmpeg-${build.version}`);
const stamp = join(sourceDirectory, ".link-studio-build");
const fingerprint = hash(specification);
if ((await readFile(stamp, "utf8").catch(() => "")) !== fingerprint) {
  execFileSync("tar", ["-xf", sourceArchive, "-C", cache], { stdio: "inherit" });
  execFileSync("sh", ["configure", ...build.configure], { cwd: sourceDirectory, stdio: "inherit" });
  execFileSync("make", ["-j", String(Math.min(availableParallelism(), 6))], {
    cwd: sourceDirectory,
    stdio: "inherit",
  });
  await writeFile(stamp, fingerprint);
}
const binaries = {};
for (const name of ["ffmpeg", "ffprobe"]) {
  const path = join(destination, name);
  await copyFile(join(sourceDirectory, name), path);
  await chmod(path, 0o755);
  const version = execFileSync(path, ["-version"], { encoding: "utf8" });
  if (version.includes("--enable-gpl") || version.includes("--enable-nonfree"))
    throw new Error("拒绝 GPL/nonfree 媒体构建");
  const dependencies = execFileSync("otool", ["-L", path], { encoding: "utf8" });
  if (
    dependencies
      .split("\n")
      .slice(1)
      .filter((line) => line.trim())
      .some((line) => !/^\s+\/(?:usr\/lib|System\/Library)\//.test(line))
  )
    throw new Error("媒体二进制包含非系统动态库依赖");
  binaries[name] = { sha256: hash(await readFile(path)), version, dependencies };
}
await copyFile(sourceArchive, join(destination, `ffmpeg-${build.version}-source.tar.xz`));
for (const name of ["COPYING.LGPLv2.1", "LICENSE.md"])
  await copyFile(join(sourceDirectory, name), join(destination, name));
await copyFile(join(root, "resources/media/README.md"), join(destination, "README.md"));
await writeFile(
  join(destination, "build-info.json"),
  `${JSON.stringify({ ...build, fingerprint, binaries }, null, 2)}\n`,
);
console.log(`媒体构建可用：${destination}`);
await buildRuntime({
  configFile: false,
  logLevel: "warn",
  build: {
    ssr: join(root, "packages/media-runtime/src/composition.ts"),
    outDir: join(root, "out/media-runtime"),
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "index.cjs", format: "cjs" } },
  },
});
