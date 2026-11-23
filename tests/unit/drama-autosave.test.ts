import { expect, test, vi } from "vitest";
import { Autosaver } from "../../src/renderer/workspace/drama-autosave";

test("连续输入等停手 800ms；在保存中切集也按新版本号串行写完", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: [string, number][] = [];
  const saver = new Autosaver({
    revision: 3,
    isConflict: () => false,
    save: async (value, revision) => {
      calls.push([value, revision]);
      if (calls.length === 1) await first;
      return revision + 1;
    },
  });
  try {
    saver.reset("", 3);
    saver.update("敲");
    saver.update("敲门");
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([["敲门", 3]]);
    saver.update("敲门。");
    const leaving = saver.flush();
    release();
    await leaving;
    expect(calls).toEqual([
      ["敲门", 3],
      ["敲门。", 4],
    ]);
    expect(saver.getStatus()).toBe("saved");
    expect(saver.getRevision()).toBe(5);
  } finally {
    saver.dispose();
    vi.useRealTimers();
  }
});

test("冲突停止自动写入；重载后才能重试；临时失败保留草稿", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce("conflict")
    .mockRejectedValueOnce("offline")
    .mockResolvedValue(8);
  const saver = new Autosaver({ revision: 1, save, isConflict: (error) => error === "conflict" });
  try {
    saver.reset("原文", 1);
    saver.update("旧稿");
    await saver.flush();
    expect(saver.getStatus()).toBe("conflict");
    saver.update("另一版旧稿");
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    saver.reset("最新", 7);
    saver.update("新稿");
    await saver.flush();
    expect(saver.getStatus()).toBe("error");
    await saver.flush();
    expect(saver.getStatus()).toBe("saved");
    expect(save.mock.calls).toEqual([
      ["旧稿", 1],
      ["新稿", 7],
      ["新稿", 7],
    ]);
  } finally {
    saver.dispose();
  }
});
