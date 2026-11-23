import type { ProjectAsset, ProjectResult, ProjectSession } from "@link-studio/core";
import type { DuplicateChoice, UploadProgress } from "./picker-uploads";

export class CanvasUploadError extends Error {
  constructor(
    message: string,
    readonly retryToken?: string,
  ) {
    super(message);
  }
}

export async function importPickerFile(
  session: ProjectSession,
  mode: ProjectAsset["importMode"],
  file: File | { fileToken: string },
  signal: AbortSignal,
  progress: (value: UploadProgress) => void,
  duplicate: () => Promise<DuplicateChoice>,
  messages: Record<string, string>,
) {
  const { projectHandle } = session;
  const { projects, dialogs } = window.desktop;
  function value<Item>(result: ProjectResult<Item>) {
    if (!result.ok)
      throw new Error(
        (result.error.code === "ASSET_SIZE_LIMIT" && result.error.message) ||
          messages[result.error.code] ||
          result.error.message ||
          "导入失败",
      );
    return result.value;
  }
  let revision = session.revision;
  signal.throwIfAborted();
  const canvas = "fileToken" in file;
  const selection = canvas
    ? { cancelled: false, files: [file] }
    : value(await dialogs.droppedMedia(projectHandle, [file]));
  if (selection.cancelled || !selection.files?.[0]) return;
  const { fileToken } = selection.files[0];
  let importSessionId: string;
  try {
    signal.throwIfAborted();
    importSessionId = value(
      await projects.startImport({
        projectHandle,
        fileToken,
        expectedRevision: revision,
        operationId: crypto.randomUUID(),
        importMode: mode,
        ...(canvas ? { forCanvasUpload: true } : { forLibrary: true }),
      }),
    ).importSessionId;
  } catch (error) {
    await projects.discardMedia({ projectHandle, fileToken });
    throw error;
  }
  const query = { projectHandle, importSessionId };
  let cancellation: ReturnType<typeof projects.cancelImport> | undefined;
  const cancel = () => (cancellation ??= projects.cancelImport(query));
  const onAbort = () => {
    void cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    let status = value(await projects.getImport(query));
    let choice: Exclude<DuplicateChoice, "cancel"> | undefined;
    while (true) {
      if (status.phase === "imported") return status;
      if (signal.aborted || status.phase === "cancelled") break;
      if (status.phase === "failed")
        throw new CanvasUploadError(messages[status.code] ?? "导入失败", status.retryToken);
      if (status.phase === "copying") {
        progress({
          status: "uploading",
          percent: status.totalBytes
            ? Math.round((100 * status.copiedBytes) / status.totalBytes)
            : 0,
        });
      } else progress({ status: "registering", percent: 100 });
      if (status.phase === "duplicate" || status.phase === "conflict") {
        if (status.phase === "duplicate" && !choice) {
          const decision = await duplicate();
          if (decision === "cancel") break;
          choice = decision;
        }
        if (status.phase === "conflict")
          revision = value(await projects.getState({ projectHandle })).session.revision;
        if (signal.aborted) break;
        status = value(
          await projects.commitImport({
            ...query,
            operationId: crypto.randomUUID(),
            expectedRevision: revision,
            ...(choice && { choice }),
          }),
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 80));
        status = value(await projects.getImport(query));
      }
    }
    const final = value(await cancel());
    if (final.phase === "imported") return final;
    if (final.phase === "failed" && final.retryToken)
      await projects.discardMedia({ projectHandle, fileToken: final.retryToken });
  } catch (error) {
    await cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
