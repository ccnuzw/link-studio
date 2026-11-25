import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HomeAssetUploadQueue, type HomeAssetUploadTask } from "./home-asset-upload-queue";

export function useHomeAssetUploads() {
  const [tasks, setTasks] = useState<HomeAssetUploadTask[]>([]);
  const queue = useRef<HomeAssetUploadQueue | null>(null);
  if (!queue.current)
    queue.current = new HomeAssetUploadQueue(
      async (task) => {
        const result = await window.desktop.dialogs.dropGlobalAsset(
          task.file,
          task.id,
          task.folder || undefined,
        );
        if (!result.ok) throw Error(result.error.message ?? "导入失败");
      },
      (operationId) => void window.desktop.projects.cancelGlobalImport({ operationId }),
      setTasks,
    );
  useEffect(() => {
    const current = queue.current;
    if (!current) return;
    current.activate();
    const unsubscribe = window.desktop.projectEvents?.onGlobalImportProgress?.((id, percent) =>
      current.progress(id, percent),
    );
    return () => {
      unsubscribe?.();
      current.deactivate();
    };
  }, []);
  return {
    tasks,
    add: (files: File[], folder: string) => queue.current?.add(files, folder),
    retry: (id: string) => queue.current?.retry(id),
    cancel: (id: string) => queue.current?.cancel(id),
  };
}

export function ImportCard({
  task,
  cancel,
  retry,
}: {
  task: HomeAssetUploadTask;
  cancel: () => void;
  retry: () => void;
}) {
  const failed = task.status === "failed";
  return (
    <article className="home-import-card" aria-label={task.file.name}>
      <button type="button" aria-label={failed ? "移除" : "取消上传"} onClick={cancel}>
        <X size={14} />
      </button>
      {failed ? <CircleAlert /> : <LoaderCircle />}
      <strong>{task.file.name}</strong>
      <small role="status">
        {failed
          ? task.error
          : task.status === "queued"
            ? "等待上传"
            : task.percent === 100
              ? "正在加入资产库"
              : `正在上传 ${task.percent}%`}
      </small>
      {failed ? (
        <button type="button" onClick={retry}>
          重试
        </button>
      ) : (
        <progress value={task.percent} max={100} />
      )}
    </article>
  );
}
