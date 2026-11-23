import { type ProjectAsset, projectImportConcurrency } from "@link-studio/core";

export type DuplicateChoice = "reuse" | "independent" | "cancel";
export type UploadProgress = { status: "uploading" | "registering"; percent: number };
export type PickerUploadTask = {
  id: string;
  file: File;
  folderId?: string;
  status: UploadProgress["status"] | "queued" | "failed";
  percent: number;
  error?: string;
  choose?: (choice: DuplicateChoice) => void;
};
export type PickerUpload<Asset = ProjectAsset> = (
  file: File,
  signal: AbortSignal,
  progress: (value: UploadProgress) => void,
  duplicate: () => Promise<DuplicateChoice>,
  destination?: string,
) => Promise<Asset | undefined>;

export function pickerUploads<Asset = ProjectAsset>(
  run: PickerUpload<Asset>,
  done: (asset: Asset) => void,
  register?: (asset: Asset, folderId?: string) => Promise<void>,
) {
  let tasks: PickerUploadTask[] = [];
  const active = new Map<string, AbortController>();
  const transferred = new Map<string, Asset>();
  const listeners = new Set<() => void>();
  function publish(next: PickerUploadTask[]) {
    tasks = next;
    for (const listener of listeners) listener();
  }
  function patch(id: string, change: Partial<PickerUploadTask>) {
    publish(tasks.map((task) => (task.id === id ? { ...task, ...change } : task)));
  }
  function remove(id: string) {
    transferred.delete(id);
    publish(tasks.filter((task) => task.id !== id));
  }
  async function start(task: PickerUploadTask) {
    const { id } = task;
    const control = new AbortController();
    active.set(id, control);
    if (!transferred.has(id)) patch(id, { status: "uploading", percent: 0, error: undefined });
    const duplicate = () =>
      new Promise<DuplicateChoice>((resolve) => {
        if (control.signal.aborted) return resolve("cancel");
        const abort = () => resolve("cancel");
        control.signal.addEventListener("abort", abort, { once: true });
        patch(id, {
          choose: (choice) => {
            control.signal.removeEventListener("abort", abort);
            patch(id, { choose: undefined });
            resolve(choice);
          },
        });
      });
    try {
      const asset =
        transferred.get(id) ??
        (await run(
          task.file,
          control.signal,
          (progress) => {
            if (!control.signal.aborted) patch(id, progress);
          },
          duplicate,
          task.folderId,
        ));
      if (asset && register && !control.signal.aborted) {
        transferred.set(id, asset);
        patch(id, { status: "registering", percent: 100, error: undefined });
        await register(asset, task.folderId);
      }
      if (!control.signal.aborted) {
        remove(id);
        if (asset) done(asset);
      }
    } catch (error) {
      if (!control.signal.aborted)
        patch(id, {
          status: "failed",
          choose: undefined,
          error: error instanceof Error && error.message ? error.message : "上传失败",
        });
    } finally {
      active.delete(id);
      pump();
    }
  }
  function pump() {
    for (const task of tasks) {
      if (active.size >= projectImportConcurrency) break;
      if (task.status === "queued" && !active.has(task.id)) void start(task);
    }
  }
  return {
    snapshot: () => tasks,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add: (files: File[], folderId?: string) => {
      publish([
        ...tasks,
        ...files.map((file) => ({
          id: crypto.randomUUID(),
          file,
          folderId,
          status: "queued" as const,
          percent: 0,
        })),
      ]);
      pump();
    },
    cancel: (id: string) => {
      active.get(id)?.abort();
      remove(id);
    },
    retry: (id: string) => {
      if (tasks.find((task) => task.id === id)?.status === "failed") {
        patch(id, { status: "queued", percent: 0, error: undefined });
        pump();
      }
    },
    clear: () => {
      transferred.clear();
      for (const control of active.values()) control.abort();
      publish([]);
    },
  };
}
