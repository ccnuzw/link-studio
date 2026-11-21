import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { AssetService } from "../../src/main/project/assets";
import { containsAssetReference, ProjectStore } from "../../src/main/project/store";

let parent: string;
let source: string;
let store: ProjectStore;
const stores: ProjectStore[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=",
  "base64",
);
const requestHash = createHash("sha256").update("test import request").digest("hex");
const binaries =
  process.env.LINK_STUDIO_MEDIA_DIRECTORY ??
  join(process.cwd(), "out/media", `${process.platform}-${process.arch}`);

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "link-studio-assets-"));
  store = await ProjectStore.create(parent, "资产测试");
  stores.push(store);
  source = join(parent, "source.png");
  await writeFile(source, png);
});

afterEach(async () => {
  for (const item of stores.splice(0)) await item.close().catch(() => undefined);
  await rm(parent, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")("S1-02 项目资产导入", () => {
  it("快照暂存后取消，保留已发布 Blob 但不登记资产，后续仍可提交", async () => {
    await store.close();
    const controller = new AbortController();
    store = await ProjectStore.open(store.directory, {
      onStage: async (stage) => {
        if (stage === "temporary-synced") controller.abort();
      },
    });
    stores.push(store);
    const handle = await open(source, "r");
    const operationId = randomUUID();
    const service = new AssetService("/unused/ffprobe");
    try {
      const result = await service.importCopy(store, handle, "source.png", operationId);
      if (result.kind !== "created") throw new Error("Expected staged asset");
      const request = { operationId, expectedRevision: 1, requestHash, asset: result.asset };
      await expect(
        store.commitAsset({ ...request, signal: controller.signal }),
      ).rejects.toMatchObject({ code: "ASSET_IMPORT_CANCELLED" });
      expect(store.snapshot).toMatchObject({ revision: 1, assets: {}, operationReceipts: {} });
      expect(await readdir(join(store.directory, "tmp"))).toEqual([]);
      await expect(store.commitAsset(request)).resolves.toMatchObject({ revision: 2 });
    } finally {
      await handle.close();
    }
  });

  it("取消已写入一部分的复制，保留源文件和项目修订", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 42);
    await writeFile(source, bytes);
    const controller = new AbortController();
    const progress: number[] = [];
    const handle = await open(source, "r");
    try {
      await expect(
        new AssetService("/unused/ffprobe").stage(store, handle, "source.png", randomUUID(), {
          signal: controller.signal,
          onProgress: (copied, total) => {
            expect(total).toBe(bytes.length);
            progress.push(copied);
            if (copied > 0) controller.abort();
          },
        }),
      ).rejects.toMatchObject({ code: "ASSET_IMPORT_CANCELLED" });
    } finally {
      await handle.close();
    }
    expect(progress).toEqual([0, 1024 * 1024]);
    expect(await readFile(source)).toEqual(bytes);
    expect(await readdir(join(store.directory, "tmp"))).toEqual([]);
    expect(store.snapshot).toMatchObject({ revision: 1, assets: {}, operationReceipts: {} });
  });

  it.each(["ENOSPC", "EIO"])("磁盘写入中途返回 %s，清理暂存文件且重开无半成品", async (code) => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 42);
    await writeFile(source, bytes);
    let writes = 0;
    const service = new AssetService("/unused/ffprobe", async (target, chunk, position) => {
      if (++writes === 2) throw Object.assign(new Error("write failed"), { code });
      return (await target.write(chunk, 0, chunk.length, position)).bytesWritten;
    });
    const handle = await open(source, "r");
    try {
      await expect(service.stage(store, handle, "source.png", randomUUID())).rejects.toMatchObject({
        code: "ASSET_STORAGE_FAILED",
        cause: { code },
      });
    } finally {
      await handle.close();
    }
    expect(writes).toBe(2);
    expect(await readFile(source)).toEqual(bytes);
    expect(await readdir(join(store.directory, "tmp"))).toEqual([]);
    await store.close();
    const reopened = await ProjectStore.open(store.directory);
    stores.push(reopened);
    expect(reopened.snapshot).toMatchObject({ revision: 1, assets: {}, operationReceipts: {} });
  });

  it("默认复制、源文件删除后重开仍可恢复完整 Blob", async () => {
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const operationId = randomUUID();
    const result = await new AssetService("/unused/ffprobe").importCopy(
      store,
      handle,
      "source.png",
      operationId,
    );
    await handle.close();
    expect(result).toMatchObject({
      kind: "created",
      asset: { mediaType: "image", metadata: { width: 2, height: 3 }, importMode: "copy" },
    });
    if (result.kind !== "created") throw new Error("expected new asset");
    const committed = await store.commitAsset({
      operationId,
      expectedRevision: 1,
      requestHash,
      asset: result.asset,
    });
    expect(committed.revision).toBe(2);
    const blob = join(
      store.directory,
      "assets",
      "sha256",
      result.asset.sha256.slice(0, 2),
      result.asset.sha256,
    );
    await unlink(source);
    expect(
      createHash("sha256")
        .update(await readFile(blob))
        .digest("hex"),
    ).toBe(result.asset.sha256);
    const directory = store.directory;
    await store.close();
    const restored = await ProjectStore.open(directory);
    stores.push(restored);
    expect(restored.snapshot.assets[result.asset.assetId]).toMatchObject({
      sha256: result.asset.sha256,
      availability: "ready",
    });
  });

  it("重复内容要求显式选择，独立记录可复用同一 Blob", async () => {
    const service = new AssetService("/unused/ffprobe");
    const firstId = randomUUID();
    const firstHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const first = await service.importCopy(store, firstHandle, "source.png", firstId);
    await firstHandle.close();
    if (first.kind !== "created") throw new Error("expected new asset");
    await store.commitAsset({
      operationId: firstId,
      expectedRevision: 1,
      requestHash,
      asset: first.asset,
    });

    const duplicateHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const duplicate = await service.importCopy(store, duplicateHandle, "copy.png", randomUUID());
    expect(duplicate).toMatchObject({
      kind: "duplicate",
      candidateAssetIds: [first.asset.assetId],
    });
    const independentId = randomUUID();
    const independent = await service.importCopy(
      store,
      duplicateHandle,
      "copy.png",
      independentId,
      "independent",
    );
    await duplicateHandle.close();
    if (independent.kind !== "created") throw new Error("expected independent asset");
    expect(independent.asset.sha256).toBe(first.asset.sha256);
    expect(independent.asset.assetId).not.toBe(first.asset.assetId);
    await store.commitAsset({
      operationId: independentId,
      expectedRevision: 2,
      requestHash,
      asset: independent.asset,
    });
    expect(Object.keys(store.snapshot.assets)).toHaveLength(2);
  });

  it.each([Buffer.from("not a png"), png.subarray(0, 24)])(
    "拒绝无效或截断的 PNG，清理临时文件",
    async (bytes) => {
      const invalid = join(parent, "invalid.png");
      await writeFile(invalid, bytes);
      const handle = await open(invalid, constants.O_RDONLY | constants.O_NOFOLLOW);
      await expect(
        new AssetService("/unused/ffprobe").importCopy(store, handle, "invalid.png", randomUUID()),
      ).rejects.toMatchObject({ code: "ASSET_READ_FAILED" });
      await handle.close();
      expect(store.snapshot.assets).toEqual({});
      expect(await readdir(join(store.directory, "tmp"))).toEqual([]);
    },
  );

  it("探测真实短 MP4 的分辨率和时长", async () => {
    const video = join(parent, "source.mp4");
    await runMediaProcess(join(binaries, "ffmpeg"), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x48:r=24:d=0.5",
      "-c:v",
      "h264_videotoolbox",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    const handle = await open(video, "r");
    try {
      const result = await new AssetService(join(binaries, "ffprobe")).importCopy(
        store,
        handle,
        "source.mp4",
        randomUUID(),
      );
      expect(result).toMatchObject({
        kind: "created",
        asset: { mediaType: "video", metadata: { width: 64, height: 48, durationMs: 500 } },
      });
    } finally {
      await handle.close();
    }
  });

  it("Blob 发布失败时不登记素材，保留源文件并清理临时文件", async () => {
    const hash = createHash("sha256").update(png).digest("hex");
    const bucket = join(store.directory, "assets", "sha256", hash.slice(0, 2));
    await mkdir(bucket, { recursive: true });
    await writeFile(join(bucket, hash), Buffer.alloc(png.length));
    const handle = await open(source, "r");
    try {
      await expect(
        new AssetService("/unused/ffprobe").importCopy(store, handle, "source.png", randomUUID()),
      ).rejects.toMatchObject({ code: "ASSET_STORAGE_FAILED" });
    } finally {
      await handle.close();
    }
    expect(store.snapshot.revision).toBe(1);
    expect(store.snapshot.assets).toEqual({});
    expect(await readdir(join(store.directory, "tmp"))).toEqual([]);
    expect(await readFile(source)).toEqual(png);
  });

  it("扫描节点/导出引用，移除后写入 tombstone 并保留 Blob", async () => {
    const operationId = randomUUID();
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const imported = await new AssetService("/unused/ffprobe").importCopy(
      store,
      handle,
      "source.png",
      operationId,
    );
    await handle.close();
    if (imported.kind !== "created") throw new Error("expected new asset");
    await store.commitAsset({
      operationId,
      expectedRevision: 1,
      requestHash,
      asset: imported.asset,
    });
    const blob = join(
      store.directory,
      "assets",
      "sha256",
      imported.asset.sha256.slice(0, 2),
      imported.asset.sha256,
    );
    expect(
      containsAssetReference(
        { nodes: [{ data: { assetId: imported.asset.assetId } }] },
        imported.asset.assetId,
      ),
    ).toBe(true);
    expect(
      containsAssetReference({ bgmAssetId: imported.asset.assetId }, imported.asset.assetId),
    ).toBe(true);
    expect(
      containsAssetReference({ inputAssetIds: [imported.asset.assetId] }, imported.asset.assetId),
    ).toBe(true);
    expect(containsAssetReference({ otherAssetIds: [randomUUID()] }, imported.asset.assetId)).toBe(
      false,
    );
    const removed = await store.removeAsset({
      operationId: randomUUID(),
      expectedRevision: 2,
      assetId: imported.asset.assetId,
    });
    expect(removed.revision).toBe(3);
    expect(store.snapshot.assets[imported.asset.assetId]?.availability).toBe("deleted");
    expect(await readFile(blob)).toEqual(png);
  });
});
