import type { ProjectAsset } from "@link-studio/core";

export type CanvasUploadSelection = { fileToken: string; displayName: string };
export type ClipboardUploadSelection = {
  clipboard: File;
  kind: ProjectAsset["mediaType"];
  displayName: string;
};
const sizes = { image: 20, video: 200, audio: 50 };

export function canvasUploadKind(
  file: Pick<File, "type" | "size">,
): { kind: ProjectAsset["mediaType"] } | { error: string } {
  const kind = /^(image|video|audio)\//.exec(file.type)?.[1];
  if (kind !== "image" && kind !== "video" && kind !== "audio")
    return { error: "只收图片、视频和音频，换个文件试试" };
  return file.size > sizes[kind] * 1024 * 1024
    ? { error: `文件超过 ${sizes[kind]}MB，换个小点的` }
    : { kind };
}

export function clipboardFileName(file: Pick<File, "type" | "name">) {
  if (!file.type.startsWith("image/") || (file.name && !/^image\.[a-z0-9]+$/i.test(file.name)))
    return file.name;
  return `粘贴图片.${file.name.split(".")[1] ?? file.type.split("/")[1] ?? "png"}`;
}

export async function transferClipboardFile(
  projectHandle: string,
  selection: ClipboardUploadSelection,
  signal: AbortSignal,
  progress: (percent: number) => void,
): Promise<CanvasUploadSelection> {
  const projects = window.desktop.projects,
    file = selection.clipboard;
  const begin = await projects.beginClipboardFile({
    projectHandle,
    name: selection.displayName,
    kind: selection.kind,
    size: file.size,
  });
  if (!begin.ok) throw Error(begin.error.messageKey);
  const { fileToken } = begin.value;
  try {
    for (let offset = 0; offset < file.size; ) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer());
      signal.throwIfAborted();
      const result = await projects.appendClipboardFile({
        projectHandle,
        fileToken,
        offset,
        bytes,
      });
      if (!result.ok || result.value.received !== offset + bytes.length || !bytes.length)
        throw Error("传输剪贴板文件失败");
      offset = result.value.received;
      progress(Math.round((100 * offset) / file.size));
    }
    signal.throwIfAborted();
    return begin.value;
  } catch (error) {
    await projects.discardMedia({ projectHandle, fileToken });
    throw error;
  }
}
