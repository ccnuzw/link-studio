import { afterEach, expect, it, vi } from "vitest";
import { createAgentMarks } from "../../src/renderer/workspace/agent-marks";

afterEach(() => vi.useRealTimers());

it("同一节点从最近一次定位重新计时，批量标记各自到期", () => {
  vi.useFakeTimers();
  const marks = createAgentMarks();
  marks.touch(["a", "b"]);
  vi.advanceTimersByTime(1400);
  marks.touch(["a"]);
  vi.advanceTimersByTime(100);
  expect([...marks.store.getState()]).toEqual([["a", "touched"]]);
  vi.advanceTimersByTime(1400);
  expect(marks.store.getState().size).toBe(0);
});

it("删除警示优先于限时描边，离开审批和切换项目时不会残留", () => {
  vi.useFakeTimers();
  const marks = createAgentMarks(),
    other = createAgentMarks();
  marks.touch(["a", "b"]);
  marks.danger(["a", "c"]);
  marks.touch(["a"]);
  vi.advanceTimersByTime(1500);
  expect([...marks.store.getState()]).toEqual([
    ["a", "danger"],
    ["c", "danger"],
  ]);
  marks.danger(["c"]);
  expect([...marks.store.getState()]).toEqual([["c", "danger"]]);
  marks.danger([]);
  marks.touch(["c"]);
  marks.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(other.store.getState().size).toBe(0);
  expect(marks.store.getState().size).toBe(0);
});
