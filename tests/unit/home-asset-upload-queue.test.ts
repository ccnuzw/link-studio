import { expect, it, vi } from "vitest";
import { HomeAssetUploadQueue } from "../../src/renderer/workspace/home-asset-upload-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a queued upload");
  return value;
}

it("cancelled uploads cannot restore a card when their IPC rejection arrives late", async () => {
  const requests = new Map<string, ReturnType<typeof deferred<void>>>();
  const cancelUpload = vi.fn();
  let tasks: { id: string; status: string }[] = [];
  const queue = new HomeAssetUploadQueue(
    (task) => {
      const request = deferred<void>();
      requests.set(task.id, request);
      return request.promise;
    },
    cancelUpload,
    (next) => {
      tasks = next;
    },
  );
  queue.activate();
  queue.add([new File([], "cancel.png")], "");
  const id = requireValue(tasks[0]).id;

  queue.cancel(id);
  expect(tasks).toEqual([]);
  expect(cancelUpload).toHaveBeenCalledWith(id);
  requireValue(requests.get(id)).reject(new Error("已取消"));
  await settle();
  expect(tasks).toEqual([]);
});

it("late upload results after unmount stay hidden after reactivation", async () => {
  const requests = new Map<string, ReturnType<typeof deferred<void>>>();
  const cancelUpload = vi.fn();
  let tasks: { id: string; file: File; status: string }[] = [];
  const queue = new HomeAssetUploadQueue(
    (task) => {
      const request = deferred<void>();
      requests.set(task.id, request);
      return request.promise;
    },
    cancelUpload,
    (next) => {
      tasks = next;
    },
  );
  queue.activate();
  queue.add([new File([], "old.png")], "");
  const oldId = requireValue(tasks[0]).id;

  queue.deactivate();
  tasks = [];
  expect(cancelUpload).toHaveBeenCalledWith(oldId);
  queue.activate();
  queue.add([new File([], "new.png")], "");
  const newId = requireValue(tasks[0]).id;
  requireValue(requests.get(oldId)).reject(new Error("已取消"));
  await settle();

  expect(tasks).toMatchObject([{ id: newId, file: { name: "new.png" }, status: "uploading" }]);
  expect(tasks).toHaveLength(1);
  queue.deactivate();
  requireValue(requests.get(newId)).reject(new Error("已取消"));
  await settle();
});
