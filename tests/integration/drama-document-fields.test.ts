import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createDrama, dramaDocument, editDramaField } from "../../src/main/project/drama";
import { ProjectStore } from "../../src/main/project/store";

test("文稿与分集元数据独立保存，重开可读，旧稿与锁定的分集不能覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-field-"));
  const source = process.env.LINK_DRAMA_SAMPLE;
  const directory = join(root, "项目副本.linkstudio");
  if (source) await cp(source, directory, { recursive: true });
  let store = source ? await ProjectStore.open(directory) : await ProjectStore.create(root, "小说");
  try {
    const doc =
      dramaDocument(store.snapshot) ??
      (await createDrama(store, { title: "来信", script: "来信。" }));
    const episode = doc.episodes.find((item) => !item.locked)!;
    const rename = { field: "title", previous: doc.title, value: "渡口" };
    await editDramaField(store, rename);
    await expect(editDramaField(store, rename)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    await expect(
      editDramaField(store, { ...rename, previous: "渡口", value: "  " }),
    ).rejects.toThrow();
    const outline = { field: "outline_md", previous: doc.outline_md, value: "## 测试大纲" };
    await editDramaField(store, outline);
    await expect(editDramaField(store, outline)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    const hook = {
      field: "hook",
      episode_no: episode.episode_no,
      episodeOrder: doc.episode_order ?? 0,
      previous: episode.hook ?? "",
      value: "一封来信",
    };
    await editDramaField(store, hook);
    await editDramaField(store, {
      field: "characters_md",
      previous: doc.characters_md,
      value: "## 信使",
    });
    await expect(
      editDramaField(store, { ...hook, previous: hook.value, episodeOrder: hook.episodeOrder + 1 }),
    ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    const actual = store.directory;
    await store.close();
    store = await ProjectStore.open(actual);
    const restored = dramaDocument(store.snapshot)!;
    expect(restored.title).toBe("渡口");
    expect(restored.outline_md).toBe(outline.value);
    expect(restored.characters_md).toBe("## 信使");
    expect(restored.episodes.find((item) => item.episode_no === episode.episode_no)?.hook).toBe(
      hook.value,
    );
    await store.updateGeneration((state) => {
      dramaDocument(state)!.episodes.find(
        (item) => item.episode_no === episode.episode_no,
      )!.locked = true;
      return { changed: true, result: null };
    });
    await expect(
      editDramaField(store, { ...hook, previous: hook.value, value: "覆盖" }),
    ).rejects.toMatchObject({ code: "DRAMA_STEP_NOT_READY" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
