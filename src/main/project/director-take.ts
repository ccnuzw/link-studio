import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectRequest } from "../../../packages/link-studio-core/src/projects-api.ts";
import type { AssetService, StagedAsset } from "./assets.ts";
import { contentHash } from "./encoding.ts";
import { ProjectError } from "./errors.ts";
import type { ProjectStore } from "./store.ts";

export async function attachDirectorTake(
  store: ProjectStore,
  service: AssetService,
  input: Pick<
    ProjectRequest<"attachDirectorTake">,
    "operationId" | "name" | "frameName" | "mp4" | "png"
  >,
  signal?: AbortSignal,
) {
  const { operationId, name, frameName, mp4, png } = input;
  if (
    !!png !== !!frameName ||
    [name, frameName ?? ""].some(
      (value) => /[\\/:*?"<>|]/u.test(value) || [...value].some((char) => char.charCodeAt(0) < 32),
    )
  )
    throw new ProjectError("VALIDATION_FAILED", "预演文件名无效");
  if (Buffer.from(mp4.buffer, mp4.byteOffset, mp4.byteLength).toString("ascii", 4, 8) !== "ftyp")
    throw new ProjectError("VALIDATION_FAILED", "无效的预演视频");
  const staged: StagedAsset[] = [];
  try {
    for (const [filename, bytes] of [
      [`${name}.mp4`, mp4],
      ...(png ? [[`${frameName}.png`, png] as const] : []),
    ] as const) {
      const path = join(store.directory, "tmp", `${randomUUID()}.take`);
      const file = await open(path, "wx+", 0o600);
      try {
        await file.writeFile(bytes, { signal });
        const item = await service.stage(store, file, filename, randomUUID(), { signal });
        item.asset.origin = "derived";
        staged.push(item);
      } finally {
        await file.close();
        await rm(path, { force: true });
      }
    }
    const requestHash = contentHash({
      kind: "director-take",
      name,
      frameName: frameName ?? null,
      hashes: staged.map((item) => item.asset.sha256),
    });
    const previous = store.replayAssetBatch(operationId, requestHash);
    if (previous) return previous;
    for (const item of staged) await service.publishBlob(store, item, signal);
    return await store.commitAssets({
      operationId,
      requestHash,
      expectedRevision: store.snapshot.revision,
      assets: staged.map((item) => item.asset),
      signal,
    });
  } finally {
    await Promise.all(staged.map((item) => service.discard(item)));
  }
}
