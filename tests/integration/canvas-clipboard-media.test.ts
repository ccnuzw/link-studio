import { randomUUID } from "node:crypto";
import { access, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AssetFiles } from "../../src/main/project/asset-files";
import { AssetService } from "../../src/main/project/assets";
import { CanvasClipboardMedia } from "../../src/main/project/canvas-clipboard";
import { ProjectStore } from "../../src/main/project/store";

test.skipIf(process.platform !== "darwin")(
  "节点剪贴板绑定窗口和最新选区，后一个素材损坏不会登记前一个",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cross-clipboard-store-"));
    const source = await ProjectStore.create(directory, "来源"),
      target = await ProjectStore.create(directory, "目标");
    const blobs = new AssetService("/unused/ffprobe"),
      media = new CanvasClipboardMedia(new AssetFiles(join(directory, "locators")), blobs);
    try {
      const records = [];
      for (const size of [32, 64]) {
        const name = `icon-${size}.png`,
          handle = await open(join(process.cwd(), "resources/icons", name), "r");
        const imported = await blobs
          .importCopy(source, handle, name, randomUUID())
          .finally(() => handle.close());
        if (imported.kind !== "created") throw Error("缺少源素材");
        await source.commitAsset({
          asset: imported.asset,
          operationId: randomUUID(),
          expectedRevision: source.snapshot.revision,
          requestHash: imported.asset.sha256,
        });
        records.push(imported.asset);
      }
      const ids = records.map((asset) => asset.assetId),
        old = media.capture(1, source, ids),
        next = media.capture(1, source, ids);
      await expect(media.paste(2, next.token, target)).rejects.toMatchObject({
        code: "TOKEN_INVALID_OR_EXPIRED",
      });
      await expect(media.paste(1, old.token, target)).rejects.toMatchObject({
        code: "TOKEN_INVALID_OR_EXPIRED",
      });
      const bad = records[1]!;
      await writeFile(
        join(source.directory, "assets", "sha256", bad.sha256.slice(0, 2), bad.sha256),
        Buffer.alloc(bad.sizeBytes),
      );
      const before = target.snapshot;
      await expect(media.paste(1, next.token, target)).rejects.toThrow();
      expect(target.snapshot).toEqual(before);
      const good = records[0]!;
      await expect(
        access(join(target.directory, "assets", "sha256", good.sha256.slice(0, 2), good.sha256)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(target.directory, "tmp"))).toEqual([]);
      media.forget(1);
      await expect(media.paste(1, next.token, target)).rejects.toMatchObject({
        code: "TOKEN_INVALID_OR_EXPIRED",
      });
    } finally {
      await source.close();
      await target.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
