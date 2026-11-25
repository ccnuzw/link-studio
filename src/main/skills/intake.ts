import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { crc32 } from "node:zlib";
import { requirePresent, skillLimits } from "@link-studio/core";
import { isMap, parseDocument } from "yaml";
import { fromBufferPromise } from "yauzl";
import { isSkillScript } from "./drama-body";

export class SkillError extends Error {}

export type SkillPackage = {
  name: string;
  title: string;
  description: string;
  warnings: string[];
  hash: string;
  files: Map<string, Buffer>;
};

const fileLimit = skillLimits.fileMiB << 20;
const totalLimit = skillLimits.totalMiB << 20;
const zipLimit = skillLimits.zipMiB << 20;
const entryLimit = 2_000;

function safePath(path: string) {
  const parts = path.split("/");
  if (
    path.length > 512 ||
    parts.length > 24 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\:*?"<>|]/.test(part) ||
        Array.from(part).some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new SkillError("技能包包含无效或不安全的文件路径。");
  return path.normalize("NFC");
}

function ignored(path: string) {
  return path
    .split("/")
    .some(
      (part) =>
        [".ds_store", "__macosx", ".git", "thumbs.db"].includes(part.toLowerCase()) ||
        part.startsWith("._"),
    );
}

async function readBounded(path: string, maximum: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new SkillError("只支持普通文件，不支持链接或特殊文件。");
    if (stat.size > maximum) throw new SkillError(`文件过大，上限为 ${maximum >> 20} MB。`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new SkillError("文件在读取期间发生变化，请重新选择。");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.mtimeMs !== stat.mtimeMs || after.size !== stat.size)
      throw new SkillError("文件在读取期间发生变化，请重新选择。");
    return bytes;
  } finally {
    await handle.close();
  }
}

class PackageFiles {
  readonly files = new Map<string, Buffer>();
  private readonly paths = new Set<string>();
  private size = 0;

  reserve(path: string, size: number) {
    const key = path.toLowerCase();
    if (this.paths.has(key)) throw new SkillError(`技能包存在重复路径：${path}`);
    if (this.paths.size >= skillLimits.files)
      throw new SkillError(`技能包最多包含 ${skillLimits.files} 个文件。`);
    if (size > fileLimit) throw new SkillError(`单个文件不能超过 ${skillLimits.fileMiB} MB。`);
    this.size += size;
    if (this.size > totalLimit)
      throw new SkillError(`技能包展开后不能超过 ${skillLimits.totalMiB} MB。`);
    this.paths.add(key);
  }
}

async function readZip(path: string, output: PackageFiles) {
  try {
    const zip = await fromBufferPromise(await readBounded(path, zipLimit), {
      strictFileNames: true,
      decodeStrings: false,
    });
    try {
      if (zip.entryCount > entryLimit) throw new SkillError("压缩包中的条目过多。");
      for await (const entry of zip.eachEntry()) {
        let filename: string;
        try {
          filename = new TextDecoder("utf-8", { fatal: true }).decode(entry.fileNameRaw);
        } catch {
          try {
            filename = new TextDecoder("gbk", { fatal: true }).decode(entry.fileNameRaw);
          } catch {
            throw new SkillError("ZIP 文件名无法按 UTF-8 或 GBK 解码。");
          }
        }
        const directory = filename.endsWith("/");
        const name = safePath(directory ? filename.slice(0, -1) : filename);
        const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (kind && kind !== (directory ? 0o040000 : 0o100000))
          throw new SkillError("技能包不支持符号链接或特殊文件。");
        if (directory || ignored(name)) continue;
        if (entry.isEncrypted()) throw new SkillError("技能包不支持加密文件。");
        if (entry.uncompressedSize > 65536 && entry.uncompressedSize > entry.compressedSize * 100)
          throw new SkillError("ZIP 压缩比超过 100:1。");
        output.reserve(name, entry.uncompressedSize);
        const stream = await zip.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        let size = 0;
        let checksum = 0;
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > entry.uncompressedSize) throw new SkillError("ZIP 条目大小与实际内容不符。");
          checksum = crc32(chunk, checksum);
          chunks.push(chunk);
        }
        if (size !== entry.uncompressedSize || checksum !== entry.crc32)
          throw new SkillError(`ZIP 文件校验失败：${name}`);
        output.files.set(name, Buffer.concat(chunks, size));
      }
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw new SkillError("无法读取 ZIP，请检查压缩包格式和文件路径。");
  }
}

async function readFolder(root: string, output: PackageFiles) {
  let entries = 0;
  async function walk(directory: string, prefix: string) {
    for await (const entry of await opendir(directory)) {
      if (++entries > entryLimit) throw new SkillError("文件夹中的条目过多。");
      const raw = prefix + entry.name;
      if (ignored(raw)) continue;
      const name = safePath(raw);
      const source = join(directory, entry.name);
      const stat = await lstat(source);
      if (stat.isDirectory()) await walk(source, `${raw}/`);
      else if (stat.isFile()) {
        output.reserve(name, stat.size);
        const bytes = await readBounded(source, fileLimit);
        if (bytes.length !== stat.size)
          throw new SkillError("文件在读取期间发生变化，请重新选择。");
        output.files.set(name, bytes);
      } else throw new SkillError("技能包不支持符号链接或特殊文件。");
    }
  }
  await walk(root, "");
}

function parseManifest(bytes: Buffer, files: Map<string, Buffer>) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n");
  } catch {
    throw new SkillError("SKILL.md 必须是有效的 UTF-8 文本。");
  }
  const match = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/.exec(text);
  if (!match?.[1] || match[1].length > 128 * 1024)
    throw new SkillError("SKILL.md 需要以两个 --- 分隔线包裹的 YAML 头部（最多 128 KiB）。");
  const options = { logLevel: "silent" as const, stringKeys: true };
  let document = parseDocument(match[1], options);
  if (document.errors.length) {
    const repaired = match[1].replace(
      /^([A-Za-z_][\w-]*):[ \t]+(\S.*)$/gm,
      (line, key, value: string) =>
        value.includes(": ") && !/^["'[{|>&*!]/.test(value)
          ? `${key}: ${JSON.stringify(value.trim())}`
          : line,
    );
    if (repaired !== match[1]) document = parseDocument(repaired, options);
  }
  if (document.errors.length || !isMap(document.contents))
    throw new SkillError("SKILL.md 的 YAML 头部格式有误。");
  const name = document.get("name");
  const rawDescription = document.get("description");
  const metadataTitle = document.getIn(["metadata", "title"]);
  const rawTitle =
    typeof metadataTitle === "string" && metadataTitle.trim()
      ? metadataTitle
      : document.get("title");
  if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new SkillError("name 必须为 1–64 个小写字母、数字或单个连字符，且首尾不能是连字符。");
  const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
  if (!description || Array.from(description).length > 1024)
    throw new SkillError("description 必须是 1–1024 个字符的说明。");
  const title = typeof rawTitle === "string" ? rawTitle.trim().slice(0, 128) || name : name;
  const warnings: string[] = [];
  const supported = new Set([
    "name",
    "title",
    "description",
    "metadata",
    "compatibility",
    "license",
  ]);
  for (const { key } of document.contents.items)
    if (!supported.has(String(key))) warnings.push(`未支持的字段：${key}（原样保存）`);
  const compatibility = document.get("compatibility");
  if (
    compatibility !== undefined &&
    (typeof compatibility !== "string" || Array.from(compatibility).length > 500)
  )
    warnings.push("compatibility 应是不超过 500 字的字符串。");
  const body = text.slice(match[0].length);
  const refs = new Set<string>();
  for (const ref of body.matchAll(
    /(?:^|[^\w/.:-])((?:references|scripts|assets)\/[\p{L}\p{N}_./-]+)/gu,
  ))
    refs.add(requirePresent(ref[1], "ref[1]").replace(/\.+$/, ""));
  for (const link of body.matchAll(/\]\(([^\s)]+)\)/g)) {
    const path = requirePresent(link[1], "link[1]").split("#")[0]?.replace(/^\.\//, "");
    if (path && !/[:]|^\//.test(path)) refs.add(path);
  }
  for (const ref of refs)
    if (
      !files.has(ref) &&
      !(ref.endsWith("/") && [...files.keys()].some((path) => path.startsWith(ref)))
    )
      warnings.push(`缺少引用文件：${ref}`);
  if ([...files.keys()].some(isSkillScript))
    warnings.push("包含脚本：Agent 只能阅读，生产任务不执行也不注入脚本。");
  for (const [path, content] of files)
    if (
      /^(7f454c46|feedface|feedfacf|cefaedfe|cffaedfe|cafebabe|4d5a)/.test(
        content.subarray(0, 4).toString("hex"),
      )
    )
      warnings.push(`含可执行二进制文件：${path}（不会执行）`);
  if (text.split("\n", 501).length > 500)
    warnings.push("SKILL.md 超过建议的 500 行，可将补充资料移到 references/。");
  if (!text.slice(match[0].length).trim()) warnings.push("SKILL.md 没有正文。");
  return { name, description, title, warnings };
}

function normalize(input: Map<string, Buffer>) {
  const files = new Map(input);
  const manifests = [...files.keys()].filter((path) => basename(path).toLowerCase() === "skill.md");
  if (manifests.length > 1) throw new SkillError("包里有多个 SKILL.md，一次只能导入一个技能。");
  const manifest = manifests[0];
  if (!manifest) throw new SkillError("技能包中没有 SKILL.md。");
  const parts = manifest.split("/");
  const wrapper = parts.length === 2 ? `${parts[0]}/` : "";
  if (parts.length > 1 && (!wrapper || [...files.keys()].some((name) => !name.startsWith(wrapper))))
    throw new SkillError("请将 SKILL.md 放在技能包的根目录。");
  const normalized = new Map(
    [...files].map(
      ([path, bytes]) =>
        [path === manifest ? "SKILL.md" : path.slice(wrapper.length), bytes] as const,
    ),
  );
  const paths = new Set([...normalized.keys()].map((path) => path.toLowerCase()));
  const hash = createHash("sha256");
  for (const path of [...normalized.keys()].sort()) {
    for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1))
      if (paths.has(path.slice(0, slash).toLowerCase()))
        throw new SkillError("技能包含有文件与目录同名的路径。");
    const bytes = normalized.get(path);
    if (bytes) hash.update(JSON.stringify([path, bytes.length])).update(bytes);
  }
  return { files: normalized, hash: hash.digest("hex"), wrapper: wrapper.slice(0, -1) };
}

export async function readSkillPackage(source: string): Promise<SkillPackage> {
  if (!isAbsolute(source)) throw new SkillError("请选择一个本地技能包。");
  const stat = await lstat(source);
  const output = new PackageFiles();
  if (stat.isDirectory()) await readFolder(source, output);
  else if (stat.isFile() && extname(source).toLowerCase() === ".zip") await readZip(source, output);
  else if (stat.isFile() && basename(source).toLowerCase() === "skill.md") {
    output.files.set("SKILL.md", await readBounded(source, fileLimit));
  } else throw new SkillError("请选择技能文件夹、ZIP 压缩包或 SKILL.md。");
  const normalized = normalize(output.files);
  const manifest = normalized.files.get("SKILL.md");
  if (!manifest) throw new SkillError("技能包中没有 SKILL.md。");
  const parsed = parseManifest(manifest, normalized.files),
    outer = normalized.wrapper || (stat.isDirectory() ? basename(source) : "");
  if (outer && outer !== parsed.name)
    parsed.warnings.push(`外层目录「${outer}」与 name 不一致，以「${parsed.name}」为准。`);
  return { ...parsed, files: normalized.files, hash: normalized.hash };
}
