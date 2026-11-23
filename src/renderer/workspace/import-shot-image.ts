import type { CreativeData, ProjectAsset, ProjectResult } from "@link-studio/core";

function unwrapResult<Value>(result: ProjectResult<Value>): Value {
  if (result.ok) return result.value;
  throw new Error(result.error.message ?? result.error.messageKey);
}

export async function importShotImage(
  projectHandle: string,
  file: File,
  progress: (percent: number) => void,
) {
  if (!file.type.startsWith("image/")) throw new Error("分镜图只能上传图片");
  if (file.size > 20 * 1024 * 1024) throw new Error("文件超过 20MB，换个小点的");
  const api = window.desktop.projects;
  const selected = unwrapResult(await window.desktop.dialogs.droppedMedia(projectHandle, [file]));
  const token = selected.cancelled ? undefined : selected.files[0]?.fileToken;
  if (!token) throw new Error("无法读取分镜图");
  let query: { projectHandle: string; importSessionId: string } | undefined;
  try {
    const latest = unwrapResult(await api.getState({ projectHandle }));
    let revision = latest.session.revision;
    const started = unwrapResult(
      await api.startImport({
        projectHandle,
        expectedRevision: revision,
        fileToken: token,
        importMode: "copy",
        operationId: crypto.randomUUID(),
      }),
    );
    query = { projectHandle, importSessionId: started.importSessionId };
    let status = unwrapResult(await api.getImport(query));
    for (;;) {
      if (status.phase === "imported") {
        if (status.asset.mediaType !== "image") throw new Error("分镜图只能上传图片");
        progress(100);
        return status;
      }
      if (status.phase === "cancelled" || status.phase === "failed")
        throw new Error("分镜图导入失败，请重新选择图片");
      if (status.phase === "conflict" || status.phase === "duplicate") {
        revision = unwrapResult(await api.getState({ projectHandle })).session.revision;
        status = unwrapResult(
          await api.commitImport({
            ...query,
            expectedRevision: revision,
            operationId: crypto.randomUUID(),
            ...(status.phase === "duplicate" ? { choice: "reuse" as const } : {}),
          }),
        );
      } else {
        if (status.totalBytes)
          progress(Math.min(99, Math.round((status.copiedBytes / status.totalBytes) * 100)));
        await new Promise((resolve) => setTimeout(resolve, 80));
        status = unwrapResult(await api.getImport(query));
      }
    }
  } catch (error) {
    if (query) await api.cancelImport(query);
    else await api.discardMedia({ projectHandle, fileToken: token });
    throw error;
  }
}

export function appendShotImage(data: CreativeData, asset: ProjectAsset): CreativeData {
  const outputs = [...(data.outputs ?? [])];
  const createdAt = new Date().toISOString();
  if (data.assetId && !outputs.some((output) => output.assetId === data.assetId)) {
    outputs.push({ id: data.assetId, assetId: data.assetId, kind: "image", createdAt });
  }
  const existing = outputs.find((output) => output.assetId === asset.assetId);
  if (!existing)
    outputs.push({ id: asset.assetId, assetId: asset.assetId, kind: "image", createdAt });
  return {
    ...data,
    assetId: asset.assetId,
    uploaded: true,
    outputs: outputs.slice(-50),
    activeOutputId: existing?.id ?? asset.assetId,
  };
}
