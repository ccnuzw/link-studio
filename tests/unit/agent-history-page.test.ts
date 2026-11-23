import { expect, it } from "vitest";
import { historyPage } from "../../packages/agent-runtime/src/history-page";
import { openStore } from "../../packages/agent-runtime/upstream/src/store/store";

it("历史页按整轮返回，插话不切页，独立长轮跨过多个 100 事件窗口", () => {
  const store = openStore(":memory:", { workerId: 2 });
  try {
    const { id } = store.createSession({
      userId: "1",
      canvasId: "1",
      title: "长会话",
      mode: "all",
      modelKey: "test",
    });
    expect(historyPage(store, id, 0)).toEqual({ events: [], hasMoreOlder: false });
    const add = (type: string, payload: unknown = {}) =>
      store.appendEvent(id, "0", type, payload).seq;
    add("session.created");
    add("message.user");
    for (let index = 0; index < 248; index++)
      add(index % 17 === 0 ? "message.user" : "tool.result", { steer: true });
    const next = add("message.user");
    for (let index = 0; index < 98; index++) add("tool.result");
    add("message.done");
    const newest = historyPage(store, id, 0);
    expect(newest.hasMoreOlder).toBe(true);
    expect(newest.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 100 }, (_, index) => next + index),
    );
    const older = historyPage(store, id, next);
    expect(older.hasMoreOlder).toBe(true);
    expect(older.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 249 }, (_, index) => index + 2),
    );
    const first = historyPage(store, id, 2);
    expect(first.hasMoreOlder).toBe(false);
    expect(first.events.map((event) => event.seq)).toEqual([1]);
    expect(historyPage(store, id, 1)).toEqual({ events: [], hasMoreOlder: false });
  } finally {
    store.close();
  }
});
