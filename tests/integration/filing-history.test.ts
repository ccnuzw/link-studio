import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { AssetFiles } from "../../src/main/project/asset-files";
import { AssetService } from "../../src/main/project/assets";
import { FilingHistory } from "../../src/main/project/filing-history";
import { PersonalLibrary } from "../../src/main/project/personal-library";
import { ProjectStore } from "../../src/main/project/store";

test.skipIf(process.platform !== "darwin")(
  "备案生成历史：多图独立、跨本地日、游标锚删除、重启及撤销访问",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "filing-history-")));
    const store = await ProjectStore.create(root, "分镜"),
      empty = await ProjectStore.create(root, "空画布");
    const files = new AssetFiles(join(root, "locators")),
      blobs = new AssetService("/unused/ffprobe");
    const library = new PersonalLibrary(join(root, "library"), files, blobs);
    const recents = [store, empty].map((project) => ({
      recentEntryId: randomUUID(),
      projectId: project.projectId,
      directory: project.directory,
      displayName: project.snapshot.name,
    }));
    const history = new FilingHistory(join(root, "index", "history.sqlite"), files, () => recents);
    try {
      await history.observe(store, recents[0]!);
      await history.observe(empty, recents[1]!);
      const file = join(process.cwd(), "resources/icons/icon-16.png");
      const descriptor = await open(file, "r");
      const staged = await blobs
        .importCopy(store, descriptor, "图.png", randomUUID())
        .finally(() => descriptor.close());
      if (staged.kind !== "created") throw Error("缺少图像");
      const now = new Date(),
        today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const ids = Array.from({ length: 45 }, () => randomUUID()),
        jobId = randomUUID();
      await store.updateGeneration((state) => {
        ids.forEach((assetId, index) => {
          state.assets[assetId] = {
            ...staged.asset,
            assetId,
            origin: "generated",
            metadata: { jobId },
            createdAt: new Date(
              index === 42 ? today - 8 * 86400000 : today + 1000 - index,
            ).toISOString(),
          };
        });
        state.assets[ids[43]!]!.availability = "deleted";
        const input = {
          nodeId: "lead",
          providerId: randomUUID(),
          expectedProviderRevision: 1,
          expectedCanvasRevision: 1,
          prompt: "双人 Portrait",
          referenceAssetIds: [],
        };
        state.jobs[jobId] = {
          id: jobId,
          version: 1,
          kind: "image",
          model: "模型",
          input,
          outputs: ids.slice(0, 44).map((assetId) => ({ kind: "image", assetId })),
        };
        for (const media of ["video", "audio"] as const) {
          const assetId = randomUUID(),
            mediaJob = randomUUID();
          state.assets[assetId] = {
            ...staged.asset,
            assetId,
            origin: "generated",
            mediaType: media,
            metadata: { jobId: mediaJob },
          };
          state.jobs[mediaJob] = {
            id: mediaJob,
            version: 1,
            kind: media,
            model: "模型",
            input,
            outputs: [{ kind: media, assetId }],
          };
        }
        return { changed: true, result: undefined };
      });
      const first = await history.page({}, "pOrTrAiT");
      expect(first.canvases).toHaveLength(2);
      expect(first.items.map((entry) => entry.origin.asset)).toEqual(ids.slice(0, 40));
      expect((await history.page({ canvas: recents[1]!.recentEntryId }, "")).items).toEqual([]);
      expect((await history.page({ conversation: true }, "")).items).toEqual([]);
      expect((await history.page({}, "图.png")).items).toEqual([]);
      const recent = await history.page({ days: 7 }, "");
      expect((await history.page({ days: 7 }, "", recent.next)).items).toHaveLength(2);
      const selected = first.items[0]!;
      for (const media of ["audio", "video"] as const) {
        const page = await history.page({}, "", undefined, media);
        expect(page.items.map((item) => item.asset.mediaType)).toEqual([media]);
        expect(await history.selection(page.items[0]!.asset.assetId)).toBeUndefined();
      }
      const ascending = await history.page({}, "", undefined, "image", true);
      expect(ascending.items[0]?.origin.asset).toBe(ids[42]);
      expect(
        (await history.page({}, "", ascending.next, "image", true)).items.at(-1)?.origin.asset,
      ).toBe(ids[0]);
      expect((await history.image(selected.asset.assetId)).bytes).toEqual(await readFile(file));
      expect((await library.filingPage()).assets).toHaveLength(0);
      const entry = (await history.lookup(selected.asset.assetId))!;
      const registered = await library.registerSource(entry.canvas, {
        ...entry.asset,
        assetId: entry.origin.asset,
      });
      expect((await library.register(store, ids[0]!)).assetId).toBe(registered.assetId);
      const attached = await library.attach(empty, registered.assetId, randomUUID());
      expect(attached.asset.sha256).toBe(staged.asset.sha256);
      expect(attached.asset.metadata.libraryItemId).toBe(registered.assetId);
      expect(await library.filingMembership(first.items)).toEqual(
        new Set([selected.asset.assetId]),
      );
      await library.removeItem(registered.assetId);
      expect(await library.filingMembership(first.items)).toEqual(new Set());
      const db = new DatabaseSync(join(root, "index", "history.sqlite"));
      try {
        db.exec(
          "CREATE TRIGGER reject_index BEFORE UPDATE ON canvases BEGIN SELECT RAISE(ABORT,'fixture'); END",
        );
        await store.updateGeneration((state) => {
          delete state.assets[ids[39]!];
          return { changed: true, result: undefined };
        });
        expect(store.warnings).toContain("生成历史索引未更新，重新打开项目后重建");
        expect(await history.selection(selected.asset.assetId)).toBeUndefined();
        await expect(history.image(selected.asset.assetId)).rejects.toThrow("历史图片已失效");
        expect((await history.page({}, "")).items).toEqual([]);
        db.exec("DROP TRIGGER reject_index");
        await history.observe(store, recents[0]!);
        expect((await history.selection(selected.asset.assetId))?.origin.asset).toBe(ids[0]);
      } finally {
        db.close();
      }
      expect(
        (await history.page({}, "", first.next)).items.map((entry) => entry.origin.asset),
      ).toEqual(ids.slice(40, 43));
      history.close();
      expect((await history.selection(selected.asset.assetId))?.origin.asset).toEqual(ids[0]);
      await rename(store.directory, `${store.directory}-moved`);
      try {
        expect(await history.selection(selected.asset.assetId)).toBeUndefined();
        await expect(history.image(selected.asset.assetId)).rejects.toThrow();
      } finally {
        await rename(`${store.directory}-moved`, store.directory);
      }
      const [revoked] = recents.splice(0, 1);
      await history.forget(revoked!.recentEntryId);
      await expect(history.image(selected.asset.assetId)).rejects.toThrow();
      expect((await history.page({}, "")).items).toEqual([]);
      recents.push({ ...revoked!, recentEntryId: randomUUID() });
      await history.observe(store, recents.at(-1)!);
      expect(await history.selection(selected.asset.assetId)).toBeUndefined();
      expect((await history.page({}, "")).items).toHaveLength(40);
    } finally {
      library.close();
      history.close();
      await store.close();
      await empty.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
