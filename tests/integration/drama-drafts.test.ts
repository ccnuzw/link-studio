import { createHash } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createDrama, dramaDocument } from "../../src/main/project/drama";
import { DramaDrafts } from "../../src/main/project/drama-drafts";
import { readDramaText } from "../../src/main/project/drama-source-blob";
import { ProjectStore } from "../../src/main/project/store";
import { requireTestValue } from "../require-test-value";

test("长篇剧本随整个项目搬移，删掉原项目仍可读取；损坏的原文不作为空稿使用", async () => {
  const parent = await mkdtemp(join(tmpdir(), "drama-source-move-"));
  const created = await ProjectStore.create(parent, "长篇剧本");
  const script = `第一集 开门\n${"窗外雨声。".repeat(3200)}\n第二集 回来\n${"她没回头。".repeat(3200)}`;
  const hash = createHash("sha256").update(script).digest("hex");
  try {
    try {
      const doc = await createDrama(created, { script, title: "来信", sourceKind: "script" });
      expect(doc.source).toMatchObject({ text: "", textBlob: hash });
      expect(doc.episodes.map((item) => item.script_md)).toEqual(
        script.split("\n第二集").map((body, index) => (index ? `第二集${body}` : body)),
      );
    } finally {
      await created.close();
    }
    const moved = join(parent, "副本.linkstudio");
    await cp(created.directory, moved, { recursive: true });
    await rm(created.directory, { recursive: true });
    const opened = await ProjectStore.open(moved);
    try {
      const source = requireTestValue(requireTestValue(dramaDocument(opened.snapshot)).source);
      expect(await readDramaText(source, opened.directory)).toBe(script);
      await writeFile(join(opened.directory, "assets", `drama-${hash}.txt`), "错误的原稿");
      await expect(readDramaText(source, opened.directory)).rejects.toThrow("短剧原文校验失败");
    } finally {
      await opened.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("同一草稿可在重开后继续报价，跨项目、已消费和刚满 24 小时返回同一错误", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drama-draft-"));
  let now = 123456;
  const file = join(directory, "drafts.sqlite"),
    clock = () => now;
  let drafts = new DramaDrafts(file, clock);
  try {
    const source = { text: "雨夜🌙", chars: 9 };
    const first = drafts.save("first", "雨夜.md", source),
      second = drafts.save("first", "另一份.txt", source);
    drafts.close();
    drafts = new DramaDrafts(file, clock);
    now += 24 * 60 * 60 * 1000 - 1;
    const expected = {
      ...source,
      filename: "雨夜.md",
      sha256: createHash("sha256").update(source.text).digest("hex"),
    };
    expect(drafts.read("first", first)).toEqual(expected);
    expect(drafts.read("first", first)).toEqual(expected);
    const expired = { code: "DRAMA_SOURCE_EXPIRED", message: "文件已过期，请重新上传" };
    expect(() => drafts.read("other", first)).toThrowError(expect.objectContaining(expired));
    drafts.remove("other", first);
    expect(drafts.read("first", first)).toEqual(expected);
    drafts.remove("first", second);
    expect(() => drafts.read("first", second)).toThrowError(expect.objectContaining(expired));
    now++;
    expect(() => drafts.read("first", first)).toThrowError(expect.objectContaining(expired));
  } finally {
    drafts.close();
    await rm(directory, { recursive: true, force: true });
  }
});
