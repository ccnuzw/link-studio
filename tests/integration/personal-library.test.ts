import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { AssetFiles } from "../../src/main/project/asset-files";
import { AssetService } from "../../src/main/project/assets";
import { PersonalLibrary } from "../../src/main/project/personal-library";
import { ProjectStore } from "../../src/main/project/store";

test("关闭项目时上传到个人库：独立条目、共享 Blob、内容校验和关闭选择窗取消", async () => {
  const directory = await mkdtemp(join(tmpdir(), "filing-library-upload-"));
  const library = new PersonalLibrary(
    directory,
    new AssetFiles(join(directory, "locators")),
    new AssetService("/unused/ffprobe"),
  );
  const signal = new AbortController().signal;
  try {
    const sample = await readFile(join(process.cwd(), "resources/icons/icon-16.png"));
    const first = await library.importFilingImage("首图.png", sample, undefined, signal);
    const second = await library.importFilingImage("副本.png", sample, undefined, signal);
    expect(first.assetId).not.toBe(second.assetId);
    expect(first.sha256).toBe(second.sha256);
    expect((await library.filingImage(first.assetId)).bytes).toEqual(sample);
    expect(await library.filingOrigins([first, second])).toEqual(
      new Map(
        [first, second].map((asset) => [
          asset.assetId,
          { project: library.projectId, asset: asset.assetId },
        ]),
      ),
    );
    await expect(
      library.importFilingImage("坏图.png", Buffer.from("not an image"), undefined, signal),
    ).rejects.toThrow();
    await expect(
      library.importFilingImage("无效.jpg", sample, undefined, signal),
    ).rejects.toThrow();
    await expect(
      library.importFilingImage("取消.png", sample, undefined, AbortSignal.abort()),
    ).rejects.toThrow();
    expect((await library.filingPage()).assets).toHaveLength(2);
    expect(await readdir(join(directory, "tmp"))).toEqual([]);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "个人库：哈希复用不合并独立条目，游标不受后来插入干扰，坏库文件不写进项目",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "link-library-cursor-"));
    const blobs = new AssetService("/unused/ffprobe"),
      files = new AssetFiles(join(directory, "locators"));
    const library = new PersonalLibrary(join(directory, "library"), files, blobs);
    const source = await ProjectStore.create(directory, "源"),
      target = await ProjectStore.create(directory, "目标");
    try {
      const folder = await library.createFolder(" 🎥角色 ");
      expect(folder.name).toBe("🎥角色");
      await expect(library.createFolder("🎥角色")).rejects.toThrow("已存在");
      await expect(library.createFolder("🎥".repeat(31))).rejects.toThrow("30");
      const file = join(directory, "图.png");
      await writeFile(
        file,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const handle = await open(file, "r");
      const staged = await blobs
        .importCopy(source, handle, "图.png", randomUUID())
        .finally(() => handle.close());
      if (staged.kind !== "created") throw new Error("未生成素材");
      const register = async (index: number) => {
        const asset = { ...staged.asset, assetId: randomUUID(), displayName: `镜头${index}.png` };
        await source.commitAsset({
          asset,
          expectedRevision: source.snapshot.revision,
          operationId: randomUUID(),
          requestHash: createHash("sha256").update(asset.assetId).digest("hex"),
        });
        const item = await library.register(source, asset.assetId, folder.id);
        expect((await library.register(source, asset.assetId)).assetId).toBe(item.assetId);
        return item;
      };
      for (let index = 0; index < 43; index++) await register(index);
      const first = await library.list(target.projectId);
      expect(first.items).toHaveLength(40);
      expect(first.next).toBeDefined();
      const root = await library.filingPage();
      expect(root.assets).toEqual([]);
      expect(root.folders).toMatchObject([{ id: folder.id, itemCount: 43 }]);
      const filingPage = await library.filingPage(undefined, "", folder.id);
      expect(filingPage.assets.map((asset) => asset.assetId)).toEqual(
        first.items.map((item) => item.asset.assetId),
      );
      expect(
        (await library.filingPage(undefined, "镜头1.PNG")).assets.map((asset) => asset.displayName),
      ).toEqual(["镜头1.png"]);
      const newest = await register(43);
      const last = await library.list(target.projectId, first.next);
      expect(last.items.map((row) => row.asset.displayName)).toEqual([
        "镜头2.png",
        "镜头1.png",
        "镜头0.png",
      ]);
      expect(last.next).toBeUndefined();
      expect(
        (await library.filingPage(filingPage.next, "", folder.id)).assets.map(
          (asset) => asset.assetId,
        ),
      ).toEqual(last.items.map((item) => item.asset.assetId));
      expect(first.items.every((row) => row.folderId === folder.id && !row.sourceId)).toBe(true);
      expect(last.folders[0]?.itemCount).toBe(44);
      const bucket = join(library.directory, "assets", "sha256", newest.sha256.slice(0, 2));
      expect(await readdir(bucket)).toEqual([newest.sha256]);
      const localPage = await library.list(source.projectId);
      expect(localPage.items.every((row) => row.sourceId)).toBe(true);
      const copied = {
        ...newest,
        assetId: randomUUID(),
        metadata: { libraryItemId: newest.assetId },
      };
      const altered = { ...copied, assetId: randomUUID(), sha256: "wrong" };
      const origins = await library.filingOrigins([
        ...localPage.items.map((row) => row.asset),
        copied,
        altered,
      ]);
      expect(origins.size).toBe(localPage.items.length + 1);
      expect(origins.get(copied.assetId)).toEqual(origins.get(newest.assetId));
      for (const row of localPage.items)
        expect(origins.get(row.asset.assetId)).toEqual({
          project: source.projectId,
          asset: row.sourceId,
        });
      expect(origins.has(altered.assetId)).toBe(false);
      const other = await library.createFolder("目标夹");
      expect((await library.listFolders()).map((folder) => folder.id)).toEqual([
        folder.id,
        other.id,
      ]);
      await library.renameFolder(other.id, "目标夹");
      await expect(library.renameFolder(other.id, " 🎥角色 ")).rejects.toThrow("已存在");
      await library.renameFolder(other.id, "空镜头");
      await library.moveItem(newest.assetId, null);
      await library.moveItem(newest.assetId, other.id);
      await library.moveItem(newest.assetId, other.id);
      const victim = localPage.items[1]!;
      await library.moveItem(victim.asset.assetId, other.id);
      const fixture = new DatabaseSync(join(library.directory, "items.sqlite"));
      try {
        fixture.exec(
          "CREATE TRIGGER fail_delete BEFORE DELETE ON library_folders BEGIN SELECT RAISE(ABORT,'rollback'); END",
        );
        await expect(library.deleteFolder(other.id)).rejects.toThrow("rollback");
        expect((await library.list("")).folders.find((row) => row.id === other.id)?.itemCount).toBe(
          2,
        );
        fixture.exec("DROP TRIGGER fail_delete");
      } finally {
        fixture.close();
      }
      expect(await library.deleteFolder(other.id)).toBe(2);
      await expect(library.filingImage(victim.asset.assetId)).rejects.toThrow("已不存在");
      expect((await library.filingPage(undefined, victim.asset.displayName)).assets).toHaveLength(
        0,
      );
      expect((await library.list(source.projectId)).removedSourceIds).toContain(victim.sourceId);
      expect((await library.list(target.projectId)).removedSourceIds).toBeUndefined();
      await expect(library.moveItem(newest.assetId, null)).rejects.toThrow("不存在");
      await expect(library.register(source, victim.sourceId!, other.id)).rejects.toThrow("不存在");
      expect(
        (await library.list("")).items.some((row) => row.asset.assetId === victim.asset.assetId),
      ).toBe(false);
      expect((await library.get(victim.asset.assetId)).assetId).toBe(victim.asset.assetId);
      expect((await library.register(source, victim.sourceId!, folder.id)).assetId).toBe(
        victim.asset.assetId,
      );
      expect((await library.list("")).folders[0]?.itemCount).toBe(43);
      expect((await library.list(source.projectId)).removedSourceIds).not.toContain(
        victim.sourceId,
      );
      await library.removeItem(victim.asset.assetId);
      await expect(library.removeItem(victim.asset.assetId)).rejects.toThrow("不存在");
      expect((await library.list("")).folders[0]?.itemCount).toBe(42);
      await writeFile(join(bucket, newest.sha256), Buffer.alloc(newest.sizeBytes, 123));
      await expect(library.attach(target, newest.assetId, randomUUID())).rejects.toThrow();
      expect(target.snapshot.assets).toEqual({});
      expect(await readdir(join(target.directory, "tmp"))).toEqual([]);
    } finally {
      library.close();
      await target.close();
      await source.close();
      await rm(directory, { force: true, recursive: true });
    }
  },
);
