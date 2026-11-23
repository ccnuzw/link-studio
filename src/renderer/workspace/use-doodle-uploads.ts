import type { ProjectAsset } from "@link-studio/core";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { canvasNotice } from "./canvas-toaster";

type Task = {
  handle: string;
  id: string;
  source: string;
  operationId: string;
  png?: string;
  writing: boolean;
  failed: boolean;
};
type Callbacks = {
  progress: (id: string, percent: number) => void;
  done: (id: string, asset: ProjectAsset, revision: number) => void;
  failed: (id: string) => void;
  remove: (id: string) => void;
};

export function useDoodleUploads(handle: string | undefined, callbacks: Callbacks) {
  const live = useRef(callbacks);
  live.current = callbacks;
  const tasks = useRef(new Map<string, Task>());
  const queue = useRef(Promise.resolve());
  const active = (task: Task) => tasks.current.get(task.id) === task;
  const forget = (id: string) => {
    const task = tasks.current.get(id);
    if (!task) return;
    tasks.current.delete(id);
    if (task.writing)
      void window.desktop.projects
        .cancelMediaTool({ projectHandle: task.handle, operationId: task.operationId })
        .catch(() => {});
  };
  useEffect(
    () => () => {
      for (const task of tasks.current.values()) if (task.handle === handle) forget(task.id);
    },
    [handle],
  );

  const write = (task: Task) => {
    task.failed = false;
    queue.current = queue.current.then(async () => {
      if (!active(task) || !task.png) return;
      try {
        const projectHandle = task.handle;
        for (let attempt = 0; attempt < 2; attempt++) {
          const snapshot = await window.desktop.projects.getCanvas({ projectHandle });
          if (!active(task)) return;
          if (!snapshot.ok) break;
          task.writing = true;
          live.current.progress(task.id, 100);
          const result = await window.desktop.projects.annotateAsset({
            projectHandle,
            operationId: task.operationId,
            assetId: task.source,
            expectedRevision: snapshot.value.revision,
            pngData: task.png,
          });
          task.writing = false;
          if (!active(task)) return;
          if (result.ok) {
            tasks.current.delete(task.id);
            live.current.done(task.id, result.value.asset, result.value.revision);
            return;
          }
          if (result.error.code !== "PROJECT_CONFLICT") break;
        }
      } catch {
      } finally {
        task.writing = false;
      }
      if (active(task)) {
        task.failed = true;
        live.current.failed(task.id);
        toast.error("涂鸦图上传失败，可以在节点上重试", canvasNotice);
      }
    });
  };
  const start = async (id: string, source: string, render: () => Promise<string>) => {
    if (!handle) return;
    const task: Task = {
      handle,
      id,
      source,
      operationId: crypto.randomUUID(),
      writing: false,
      failed: false,
    };
    tasks.current.set(id, task);
    try {
      task.png = await render();
      if (active(task)) write(task);
    } catch (error) {
      if (!active(task)) return;
      tasks.current.delete(id);
      live.current.remove(id);
      toast.error(error instanceof Error ? error.message : "保存失败，请稍后重试", canvasNotice);
    }
  };
  const retry = (id: string) =>
    tasks.current.get(id)?.failed
      ? () => {
          const task = tasks.current.get(id);
          if (!task?.failed) return;
          live.current.progress(id, 0);
          write(task);
        }
      : undefined;
  return { start, retry, forget };
}
