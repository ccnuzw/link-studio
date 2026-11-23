import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssetFiles,
  type AssetRecord,
  type MediaLocation,
  readOnly,
  verifyContent,
} from "./asset-files.ts";
import type { AssetService, StagedAsset } from "./assets.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import { requireDirectory } from "./ownership.ts";
import type { ProjectStore } from "./store.ts";

export class CanvasClipboardMedia {
  private readonly grants = new Map<
    number,
    { token: string; source: MediaLocation; assets: AssetRecord[] }
  >();

  constructor(
    private files: AssetFiles,
    private blobs: AssetService,
  ) {}

  forget(owner: number) {
    this.grants.delete(owner);
  }

  capture(owner: number, store: ProjectStore, ids: string[]) {
    this.forget(owner);
    const snapshot = ids.length ? store.snapshot : undefined;
    const assets = ids.map((id) => {
      const asset = snapshot?.assets[id];
      if (asset?.availability !== "ready")
        throw new ProjectError("ASSET_NOT_FOUND", "选区中的素材不可用");
      return asset;
    });
    const token = randomUUID();
    this.grants.set(owner, {
      token,
      source: { directory: store.directory, projectId: store.projectId },
      assets,
    });
    return { token };
  }

  async paste(owner: number, token: string, store: ProjectStore, signal?: AbortSignal) {
    const grant = this.grants.get(owner);
    if (!grant || grant.token !== token)
      throw new ProjectError("TOKEN_INVALID_OR_EXPIRED", "节点剪贴板已更换");
    const state = store.snapshot;
    const ids: Record<string, string> = {};
    const staged: StagedAsset[] = [];
    const assets: StagedAsset["asset"][] = [];
    const sameProject =
      grant.source.directory === store.directory && grant.source.projectId === store.projectId;
    const byOrigin = new Map(
      Object.values(state.assets)
        .filter(
          (asset) =>
            asset.availability === "ready" &&
            asset.storage.kind === "blob" &&
            typeof asset.metadata.clipboardOrigin === "string",
        )
        .map((asset) => [asset.metadata.clipboardOrigin, asset]),
    );
    const directory = join(store.directory, "tmp");
    try {
      for (const original of grant.assets) {
        signal?.throwIfAborted();
        const key = contentHash([grant.source.projectId, original.assetId, original.sha256]);
        const existing = sameProject ? state.assets[original.assetId] : byOrigin.get(key);
        if (existing?.availability === "ready" && existing.sha256 === original.sha256) {
          const verified = await this.files.inspect(store, existing, true);
          await verified.handle.close();
          ids[original.assetId] = existing.assetId;
          assets.push({ ...existing, availability: "ready" });
          continue;
        }
        const asset: StagedAsset["asset"] = {
          ...original,
          assetId: randomUUID(),
          availability: "ready",
          origin: "imported",
          importMode: "copy",
          storage: { kind: "blob", hash: original.sha256 },
          createdAt: new Date().toISOString(),
          metadata: {
            ...Object.fromEntries(
              Object.entries(original.metadata).filter(([field]) =>
                ["width", "height", "displayAspect", "durationMs", "sampleRate", "timeMs"].includes(
                  field,
                ),
              ),
            ),
            clipboardOrigin: key,
          },
        };
        if (!staged.length) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await requireDirectory(directory);
        }
        const temporary = join(directory, `${randomUUID()}.clipboard`);
        await this.files.materialize(grant.source, original, temporary, signal);
        staged.push({ temporary, asset });
        const file = await open(temporary, readOnly);
        try {
          await verifyContent(file, asset, undefined, signal);
          await file.sync();
        } finally {
          await file.close();
        }
        assets.push(asset);
        ids[original.assetId] = asset.assetId;
      }
      for (const item of staged) await this.blobs.publishBlob(store, item, signal);
      const revision = staged.length
        ? (
            await store.commitAssets({
              purpose: "clipboard",
              assets: staged.map((item) => item.asset),
              operationId: randomUUID(),
              requestHash: contentHash(ids),
              expectedRevision: state.revision,
              signal,
            })
          ).revision
        : state.revision;
      return { ids, assets, revision };
    } finally {
      await Promise.all(staged.map((item) => this.blobs.discard(item)));
    }
  }
}
