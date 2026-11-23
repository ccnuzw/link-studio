import type { SettingsEvent } from "@link-studio/core";
import { expect, test } from "vitest";
import { latestPlan } from "../../src/renderer/assistant/run-plan";
import { toolHistory } from "../../src/renderer/assistant/tool-history";

const event = (seq: number, type: string, payload: unknown, runId = "first"): SettingsEvent => ({
  seq,
  type,
  payload,
  runId,
});
const tool = (seq: number, phase: string, id: string, name: string, extra = {}) =>
  event(seq, `tool.${phase}`, { id, name, ...extra });
const plan = (seq: number, status: string) =>
  event(seq, "plan.updated", { steps: [{ title: "确认模型", status }] });
const status = (seq: number, status: string) => event(seq, "run.status", { status });
const groups = (events: SettingsEvent[]) =>
  toolHistory(events, true).filter((item) => "tools" in item);

test("卡片独立占位，失败的展示保留在调用位置，迟到的结果合并回原组", () => {
  const events = [
    status(1, "running"),
    tool(2, "start", "read", "canvas_read"),
    tool(3, "start", "card", "show_card"),
    event(4, "card.shown", {
      card: { kind: "summary", title: "检查", rows: [{ label: "结论", value: "通过" }] },
    }),
    tool(5, "end", "card", "show_card"),
    tool(6, "start", "bad", "show_card"),
    event(7, "message.done", { text: "已检查" }),
    tool(8, "end", "read", "canvas_read", { node_ids: ["node"] }),
    tool(9, "end", "bad", "show_card", { is_error: true }),
    status(10, "canceled"),
  ];
  const projected = groups(events);
  expect(projected.map((group) => [...group.tools.keys()])).toEqual([["read"], ["bad"]]);
  expect(projected[0]?.tools.get("read")?.nodeIds).toEqual(["node"]);
  expect(projected[1]?.tools.get("bad")?.failed).toBe(true);
  expect(projected.every((group) => !group.running && !group.aborted)).toBe(true);
});

test("只中止还没有结果的工具，读取结束后维持展开直到正文出现", () => {
  const done = [status(1, "running"), tool(2, "start", "a", "read"), tool(3, "end", "a", "read")];
  expect(groups(done)[0]?.running).toBe(true);
  expect(groups([...done, event(4, "message.done", { text: "结果" })])[0]?.running).toBe(false);
  const stopped = groups([
    ...done,
    event(4, "tasks.settled", {}),
    tool(5, "start", "b", "read"),
    status(6, "canceled"),
  ]);
  expect(stopped.map((group) => group.aborted)).toEqual([false, true]);
});

test("计划条跟随最新运行，完成提示锚定在第一次完成处，未完成可回放", () => {
  const active = [status(1, "running"), plan(2, "doing")];
  expect(latestPlan(active)).toMatchObject({ active: true, steps: [{ status: "doing" }] });
  expect(latestPlan([...active, status(3, "canceled")])).toMatchObject({ active: false });
  expect(latestPlan([...active, event(3, "run.status", { status: "running" }, "next")])).toBeNull();
  const done = [...active, plan(3, "done"), plan(4, "done"), status(5, "completed")];
  expect(latestPlan(done)).toBeNull();
  expect(
    toolHistory(done, true).filter((item) => "type" in item && item.type === "plan.updated"),
  ).toEqual([done[2]]);
});
