import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DramaDocument } from "../../../packages/link-studio-core/src/drama.ts";
import { ProjectError } from "./errors.ts";
import { requireDirectory } from "./ownership.ts";
import { syncDirectory } from "./store.ts";

type Source = NonNullable<DramaDocument["source"]>;

export async function readDramaText(source: Pick<Source, "text" | "textBlob">, directory?: string) {
  if (!source.textBlob) return source.text;
  if (!directory || !/^[a-f0-9]{64}$/u.test(source.textBlob))
    throw new ProjectError("PROJECT_CORRUPT", "短剧原文索引无效");
  const assets = join(directory, "assets");
  await requireDirectory(assets);
  const file = await open(
    join(assets, `drama-${source.textBlob}.txt`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 20_000_000)
      throw new ProjectError("PROJECT_CORRUPT", "短剧原文文件无效");
    const bytes = await file.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== source.textBlob)
      throw new ProjectError("PROJECT_CORRUPT", "短剧原文校验失败");
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
}

export async function storeDramaText(
  directory: string,
  text: string,
): Promise<Pick<Source, "text" | "textBlob">> {
  if (text.length <= 24000) return { text };
  const textBlob = createHash("sha256").update(text).digest("hex");
  const assets = join(directory, "assets"),
    tmp = join(directory, "tmp");
  await requireDirectory(assets);
  await requireDirectory(tmp);
  const temporary = join(tmp, `${randomUUID()}.asset`),
    file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, join(assets, `drama-${textBlob}.txt`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await readDramaText({ text: "", textBlob }, directory);
    }
    await syncDirectory(assets);
    return { text: "", textBlob };
  } finally {
    await unlink(temporary);
  }
}
