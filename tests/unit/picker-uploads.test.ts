import type { ProjectAsset } from "@link-studio/core";
import { expect, test, vi } from "vitest";
import { type PickerUpload, pickerUploads } from "../../src/renderer/workspace/picker-uploads";
import { requireTestValue } from "../require-test-value";

function fixture() {
  const attempts: {
    args: Parameters<PickerUpload>;
    resolve: (asset?: ProjectAsset) => void;
    reject: (error: Error) => void;
  }[] = [];
  const done = vi.fn();
  const queue = pickerUploads(
    (...args) => new Promise((resolve, reject) => attempts.push({ args, resolve, reject })),
    done,
  );
  const files = ["甲", "乙", "丙", "丁", "戊"].map((name) => new File([], name));
  return { attempts, done, queue, files };
}

test("并发槽等待 IPC 收尾；已取消任务的迟到进度和结果不回流", async () => {
  const { attempts, done, queue, files } = fixture();
  queue.add(files);
  expect(attempts.map((task) => task.args[0])).toEqual(files.slice(0, 3));
  const { id } = requireTestValue(queue.snapshot()[0]);
  const [original, second] = attempts;
  const decision = requireTestValue(original).args[3]();
  queue.cancel(id);
  expect(await decision).toBe("cancel");
  expect(requireTestValue(original).args[1].aborted).toBe(true);
  expect(attempts).toHaveLength(3);
  requireTestValue(original).args[2]({ status: "uploading", percent: 79 });
  expect(queue.snapshot().some((task) => task.id === id)).toBe(false);
  requireTestValue(original).resolve({ assetId: "迟到" } as ProjectAsset);
  await Promise.resolve();
  expect(requireTestValue(attempts[3]).args[0]).toBe(files[3]);
  expect(done).not.toHaveBeenCalled();
  for (const index of [3, 1, 4, 2]) {
    requireTestValue(attempts[index]).resolve({ assetId: String(index) } as ProjectAsset);
    await Promise.resolve();
  }
  expect(done.mock.calls.map(([asset]) => asset.assetId)).toEqual(["3", "1", "4", "2"]);
  expect(queue.snapshot()).toEqual([]);
  expect(requireTestValue(second).args[1].aborted).toBe(false);
});

test("同一文件的多个任务独立重试；关闭后清除排队、拒绝和迟到成功", async () => {
  const { attempts, queue, files, done } = fixture();
  const file = requireTestValue(files[0]);
  queue.add([file, file]);
  requireTestValue(attempts[0]).reject(new Error("读取失败"));
  await Promise.resolve();
  const [first, second] = queue.snapshot();
  expect(first).toMatchObject({ status: "failed", error: "读取失败" });
  expect(second?.status).toBe("uploading");
  queue.retry(requireTestValue(first).id);
  queue.retry(requireTestValue(first).id);
  expect(attempts).toHaveLength(3);
  expect(requireTestValue(attempts[2]).args[0]).toBe(file);
  expect(queue.snapshot()[0]).toMatchObject({
    id: requireTestValue(first).id,
    status: "uploading",
    percent: 0,
    error: undefined,
  });
  queue.add(files);
  expect(attempts).toHaveLength(4);
  queue.clear();
  for (const [index, attempt] of attempts.slice(1).entries()) {
    expect(attempt.args[1].aborted).toBe(true);
    if (index % 2) attempt.reject(new Error("中止"));
    else attempt.resolve({ assetId: "旧结果" } as ProjectAsset);
  }
  await Promise.resolve();
  expect(queue.snapshot()).toEqual([]);
  expect(attempts).toHaveLength(4);
  expect(done).not.toHaveBeenCalled();
});
