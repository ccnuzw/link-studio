import type { ProjectAsset, ProjectSession } from "@link-studio/core";
import { projectImportConcurrency } from "@link-studio/core";
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { createContext, useContext, useEffect, useRef } from "react";
import {
  type CanvasUploadSelection,
  type ClipboardUploadSelection,
  transferClipboardFile,
} from "./canvas-upload-file";
import { CanvasUploadError, importPickerFile } from "./import-picker-file";

type Task = {
  id: string;
  selection: CanvasUploadSelection | ClipboardUploadSelection;
  session: ProjectSession;
  mode: ProjectAsset["importMode"];
  controller: AbortController;
};

export const CanvasUploadContext = createContext<(id: string) => (() => void) | undefined>(
  () => undefined,
);
export function CanvasUploadBody({
  id,
  progress,
  interrupted,
}: {
  id: string;
  progress?: number;
  interrupted?: boolean;
}) {
  const retry = useContext(CanvasUploadContext)(id);
  return (
    <div className="node-media canvas-upload-body">
      {progress === undefined || interrupted ? (
        <div className="character-image-task failed" role="alert">
          <TriangleAlert />
          <p>{interrupted ? "上传已中断，请删除后重新上传" : "上传失败，请重试"}</p>
          {!interrupted && retry && (
            <span>
              <button type="button" className="task-action nodrag" onClick={retry}>
                <RotateCcw />
                重试
              </button>
            </span>
          )}
        </div>
      ) : (
        <div className="character-image-task" role="status" aria-live="polite">
          <div className="character-task-line">
            <Loader2 className="shot-split-spinner" />
            {progress >= 100 ? "处理中" : "上传中"}
            <span>{progress}%</span>
          </div>
          {progress >= 100 && <p>文件已传完，正在保存</p>}
          <div className="character-task-track">
            <i style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

export function useCanvasUploads(
  handle: string | undefined,
  callbacks: {
    progress: (id: string, percent: number) => void;
    failed: (id: string) => void;
    remove: (id: string) => void;
    done: (id: string, asset: ProjectAsset, revision: number) => void;
  },
) {
  const live = useRef(callbacks);
  live.current = callbacks;
  const tasks = useRef(new Map<string, Task>());
  const running = useRef(0);
  const waiters = useRef<Array<() => void>>([]);
  const retries = useRef(new Map<string, Task>());
  const discard = (task: Task) =>
    "fileToken" in task.selection &&
    window.desktop.projects.discardMedia({
      projectHandle: task.session.projectHandle,
      fileToken: task.selection.fileToken,
    });
  function forget(id: string) {
    tasks.current.get(id)?.controller.abort();
    const retry = retries.current.get(id);
    if (retry) {
      retries.current.delete(id);
      void discard(retry);
    }
  }
  useEffect(
    () => () => {
      for (const id of [...tasks.current.keys(), ...retries.current.keys()]) forget(id);
    },
    [handle],
  );
  async function start(task: Task): Promise<"done" | "failed" | "aborted"> {
    const { id, session, selection, mode, controller } = task;
    tasks.current.set(id, task);
    if (running.current >= projectImportConcurrency)
      await new Promise<void>((resolve) => waiters.current.push(resolve));
    else running.current++;
    const signal = controller.signal;
    try {
      if (signal.aborted) {
        await discard(task);
        return "aborted";
      }
      const clip = "clipboard" in selection;
      const source = clip
        ? await transferClipboardFile(session.projectHandle, selection, signal, (percent) => {
            if (!signal.aborted) live.current.progress(id, percent);
          })
        : selection;
      if (signal.aborted) {
        await window.desktop.projects.discardMedia({
          projectHandle: session.projectHandle,
          fileToken: source.fileToken,
        });
        return "aborted";
      }
      const result = await importPickerFile(
        session,
        clip ? "copy" : mode,
        source,
        signal,
        (value) => {
          if (!clip && !signal.aborted) live.current.progress(id, value.percent);
        },
        async () => "independent",
        {},
      );
      if (!signal.aborted && result) {
        live.current.done(id, result.asset, result.revision);
        return "done";
      }
      if (!signal.aborted) live.current.remove(id);
      return "aborted";
    } catch (error) {
      if ("clipboard" in selection) {
        if (!signal.aborted)
          retries.current.set(id, { ...task, controller: new AbortController() });
      } else if (error instanceof CanvasUploadError && error.retryToken) {
        const retained = {
          ...task,
          selection: { ...selection, fileToken: error.retryToken },
          controller: new AbortController(),
        };
        if (signal.aborted) await discard(retained);
        else retries.current.set(id, retained);
      }
      if (signal.aborted) return "aborted";
      live.current.failed(id);
      return "failed";
    } finally {
      if (tasks.current.get(id) === task) tasks.current.delete(id);
      const next = waiters.current.shift();
      if (next) next();
      else running.current--;
    }
  }
  const retry = (id: string) =>
    retries.current.has(id)
      ? () => {
          const task = retries.current.get(id);
          if (!task) return;
          retries.current.delete(id);
          live.current.progress(id, 0);
          void start(task);
        }
      : undefined;
  return { start, forget, retry };
}
